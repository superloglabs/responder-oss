import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { subscriptionModelsRunner } from "./subscription-models.js";

it("discovers all visible subscription models through managed authentication and pagination", async () => {
  const root = await mkdtemp(join(tmpdir(), "responder-models-test-"));
  try {
    await mkdir(join(root, "node_modules/.bin"), { recursive: true });
    await mkdir(join(root, "auth"));
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
