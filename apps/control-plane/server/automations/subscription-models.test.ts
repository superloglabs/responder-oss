import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { beforeEach, expect, it, vi } from "vitest";
import { runSubscriptionClient, subscriptionModelsRunner } from "./subscription-models.js";

const daytona = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn(),
  sandbox: {
    fs: { downloadFile: vi.fn(), uploadFile: vi.fn() },
    process: { executeCommand: vi.fn() },
  },
}));
const credentials = vi.hoisted(() => ({
  acquireSubscriptionCredential: vi.fn(),
  persistSubscriptionCredential: vi.fn(),
  releaseSubscriptionCredential: vi.fn(),
}));
vi.mock("@daytona/sdk", () => ({
  Daytona: vi.fn(function Daytona() {
    return { create: daytona.create, delete: daytona.delete, [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) };
  }),
}));
vi.mock("../../../../packages/core/src/daytona-config.js", () => ({
  daytonaClientOptions: () => ({}),
  requireDaytonaClientConfig: () => ({ sandboxSnapshotName: "snapshot" }),
}));
vi.mock("../../../../packages/core/src/db/automation-model-credentials.js", () => credentials);

const owner = { credentialId: "credential", organizationId: "organization" };
const task = { name: "usage", output: "usage.json", root: "/root", runner: "runner" };
const storedAuth = JSON.stringify({ tokens: { id_token: "id", access_token: "access", refresh_token: "refresh", account_id: "account" } });
const refreshedAuth = storedAuth.replace("refresh", "renewed");

beforeEach(() => {
  vi.clearAllMocks();
  credentials.acquireSubscriptionCredential.mockResolvedValue(storedAuth);
  daytona.create.mockResolvedValue(daytona.sandbox);
  daytona.sandbox.process.executeCommand.mockResolvedValue({ exitCode: 0 });
  daytona.sandbox.fs.uploadFile.mockResolvedValue(undefined);
});

it("keeps a login the client refreshed even when the client fails", async () => {
  daytona.sandbox.process.executeCommand.mockResolvedValueOnce({ exitCode: 0 }).mockResolvedValueOnce({ exitCode: 1 });
  daytona.sandbox.fs.downloadFile.mockResolvedValue(Buffer.from(refreshedAuth));
  await expect(runSubscriptionClient(owner, task)).rejects.toThrow("The subscription client failed");
  expect(daytona.sandbox.fs.downloadFile).toHaveBeenCalledWith("/root/auth/auth.json");
  expect(credentials.persistSubscriptionCredential).toHaveBeenCalledWith(expect.objectContaining({ authJson: refreshedAuth, previousAccountId: "account" }));
  expect(daytona.delete).toHaveBeenCalledWith(daytona.sandbox);
  expect(credentials.releaseSubscriptionCredential).toHaveBeenCalledOnce();
});

it("does not read the login back when the client never started", async () => {
  daytona.sandbox.fs.uploadFile.mockRejectedValueOnce(new Error("Request failed with status code 502"));
  await expect(runSubscriptionClient(owner, task)).rejects.toThrow("502");
  expect(daytona.sandbox.fs.downloadFile).not.toHaveBeenCalled();
  expect(credentials.persistSubscriptionCredential).not.toHaveBeenCalled();
  expect(daytona.delete).toHaveBeenCalledWith(daytona.sandbox);
  expect(credentials.releaseSubscriptionCredential).toHaveBeenCalledOnce();
});

it("discovers all visible subscription models through managed authentication and pagination", async () => {
  const root = await mkdtemp(join(tmpdir(), "responder-models-test-"));
  try {
    await mkdir(join(root, "node_modules/.bin"), { recursive: true });
    await mkdir(join(root, "auth"));
    expect(subscriptionModelsRunner).toContain("/home/daytona/.responder-model-catalog");
    await writeFile(join(root, "node_modules/.bin/codex"), `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n");
rl.on("line", line => {
 const message = JSON.parse(line);
 if (message.method === "initialize") send(message.id, {});
 if (message.method === "account/read") {
   if (!message.params.refreshToken) process.exit(1);
   send(message.id, { account: { type: "chatgpt" } });
 }
 if (message.method === "model/list") {
   if (message.params.includeHidden) process.exit(1);
   send(message.id, message.params.cursor ? { data: [{ model: "gpt-new", displayName: "New model", hidden: false }], nextCursor: null } : { data: [{ model: "gpt-current", displayName: "Current model", hidden: false }, { model: "gpt-hidden", displayName: "Hidden", hidden: true }], nextCursor: "next" });
 }
});
`, { mode: 0o700 });
    await writeFile(join(root, "models.mjs"), subscriptionModelsRunner.replaceAll("/home/daytona/.responder-model-catalog", root));
    const child = spawn("node", [join(root, "models.mjs")], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error("Model discovery failed"))); });
    expect(JSON.parse(await readFile(join(root, "models.json"), "utf8"))).toEqual([{ id: "gpt-current", name: "Current model" }, { id: "gpt-new", name: "New model" }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
