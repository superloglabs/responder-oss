import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubscriptionCredentialUnavailableError } from "@responder/core/db/automation-model-credentials";
import { describe, expect, it, vi } from "vitest";
import {
  createSubscriptionRunSecret,
  deleteSubscriptionRunSecret,
  subscriptionAuthCoveringRun,
  subscriptionRefreshRunner,
  type SubscriptionAccessDependencies,
} from "./subscription-access.js";

const daytonaSecrets = vi.hoisted(() => ({ create: vi.fn(), delete: vi.fn() }));
vi.mock("@daytona/sdk", () => ({
  Daytona: vi.fn(function Daytona() {
    return { secret: daytonaSecrets, [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) };
  }),
}));

const owner = { credentialId: "credential", organizationId: "organization" };
const now = new Date("2026-09-29T12:00:00.000Z");
const validUntil = new Date(now.getTime() + 90 * 60_000);

function authExpiringAt(expiresAt: Date, refreshToken = "stored-refresh") {
  const claims = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt.getTime() / 1_000) })).toString("base64url");
  return JSON.stringify({ tokens: { id_token: "id", access_token: `header.${claims}.signature`, refresh_token: refreshToken, account_id: "account" } });
}

function dependencies() {
  let clock = now.getTime();
  return {
    getAuthJson: vi.fn<SubscriptionAccessDependencies["getAuthJson"]>(),
    now: () => new Date(clock),
    refresh: vi.fn<SubscriptionAccessDependencies["refresh"]>().mockResolvedValue(undefined),
    sleep: vi.fn(async (ms: number) => { clock += ms; }),
  };
}

describe("subscriptionAuthCoveringRun", () => {
  it("shares a login that outlives the run without refreshing it", async () => {
    const deps = dependencies();
    const stored = authExpiringAt(new Date(now.getTime() + 24 * 3_600_000));
    deps.getAuthJson.mockResolvedValue(stored);
    await expect(subscriptionAuthCoveringRun(owner, validUntil, deps)).resolves.toBe(stored);
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it("refreshes a login that would expire during the run", async () => {
    const deps = dependencies();
    const renewed = authExpiringAt(new Date(now.getTime() + 240 * 3_600_000));
    deps.getAuthJson
      .mockResolvedValueOnce(authExpiringAt(new Date(now.getTime() + 30 * 60_000)))
      .mockResolvedValueOnce(renewed);
    await expect(subscriptionAuthCoveringRun(owner, validUntil, deps)).resolves.toBe(renewed);
    expect(deps.refresh).toHaveBeenCalledOnce();
    expect(deps.refresh).toHaveBeenCalledWith(owner);
  });

  it("fails instead of refreshing twice when the login is not renewed", async () => {
    const deps = dependencies();
    deps.getAuthJson.mockResolvedValue(authExpiringAt(new Date(now.getTime() + 30 * 60_000)));
    await expect(subscriptionAuthCoveringRun(owner, validUntil, deps)).rejects.toThrow("did not renew");
    expect(deps.refresh).toHaveBeenCalledOnce();
  });

  it("waits for another refresh and uses its result", async () => {
    const deps = dependencies();
    const renewed = authExpiringAt(new Date(now.getTime() + 240 * 3_600_000));
    deps.getAuthJson
      .mockResolvedValueOnce(authExpiringAt(new Date(now.getTime() + 30 * 60_000)))
      .mockResolvedValueOnce(renewed);
    deps.refresh.mockRejectedValueOnce(new SubscriptionCredentialUnavailableError());
    await expect(subscriptionAuthCoveringRun(owner, validUntil, deps)).resolves.toBe(renewed);
    expect(deps.refresh).toHaveBeenCalledOnce();
    expect(deps.sleep).toHaveBeenCalledOnce();
  });

  it("stops waiting when the lease is never released", async () => {
    const deps = dependencies();
    deps.getAuthJson.mockResolvedValue(authExpiringAt(new Date(now.getTime() + 30 * 60_000)));
    deps.refresh.mockRejectedValue(new SubscriptionCredentialUnavailableError());
    await expect(subscriptionAuthCoveringRun(owner, validUntil, deps)).rejects.toBeInstanceOf(SubscriptionCredentialUnavailableError);
    expect(deps.sleep.mock.calls.length).toBeGreaterThan(1);
    expect(deps.sleep.mock.calls.length).toBeLessThanOrEqual(49);
  });

  it("does not retry other refresh failures", async () => {
    const deps = dependencies();
    deps.getAuthJson.mockResolvedValue(authExpiringAt(new Date(now.getTime() + 30 * 60_000)));
    deps.refresh.mockRejectedValue(new Error("Unable to refresh the ChatGPT subscription"));
    await expect(subscriptionAuthCoveringRun(owner, validUntil, deps)).rejects.toThrow("Unable to refresh");
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("fails when the subscription is no longer connected", async () => {
    const deps = dependencies();
    deps.getAuthJson.mockResolvedValue(null);
    await expect(subscriptionAuthCoveringRun(owner, validUntil, deps)).rejects.toThrow("Reconnect");
    expect(deps.refresh).not.toHaveBeenCalled();
  });
});

async function runRefreshRunner(accountType: string, withError = false) {
  const root = await mkdtemp(join(tmpdir(), "responder-refresh-test-"));
  try {
    await mkdir(join(root, "auth"));
    const codex = join(root, "codex");
    await writeFile(codex, `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n");
rl.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send(message.id, {});
  if (message.method === "account/read") {
    if (!message.params.refreshToken) process.exit(1);
    ${withError ? 'process.stdout.write(JSON.stringify({ id: message.id, error: { message: "failed" } }) + "\\n");' : `send(message.id, { account: { type: ${JSON.stringify(accountType)} } });`}
  }
});
`, { mode: 0o700 });
    expect(subscriptionRefreshRunner).toContain("/home/daytona/.responder-subscription-refresh");
    await writeFile(join(root, "refresh.mjs"), subscriptionRefreshRunner.replaceAll("/home/daytona/.responder-subscription-refresh", root));
    const child = spawn("node", [join(root, "refresh.mjs"), codex], { stdio: "ignore" });
    return await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe("subscriptionRefreshRunner", () => {
  it("asks the official client to refresh a ChatGPT login", async () => {
    await expect(runRefreshRunner("chatgpt")).resolves.toBe(0);
  });

  it("fails for other accounts and app-server errors", async () => {
    await expect(runRefreshRunner("apiKey")).resolves.toBe(1);
    await expect(runRefreshRunner("chatgpt", true)).resolves.toBe(1);
  });
});

describe("subscription run secrets", () => {
  const environment = { DAYTONA_API_KEY: "daytona-key" };

  it("keeps the access token in a Daytona secret limited to ChatGPT", async () => {
    daytonaSecrets.create.mockResolvedValue({ id: "secret-1", name: "responder_chatgpt_run", placeholder: "dtn_secret_abc" });
    await expect(createSubscriptionRunSecret({ accessToken: "access", runId: "21212121-2121-4121-8121-212121212121" }, environment))
      .resolves.toEqual({ id: "secret-1", name: "responder_chatgpt_run", placeholder: "dtn_secret_abc" });
    expect(daytonaSecrets.create).toHaveBeenCalledWith(expect.objectContaining({
      hosts: ["chatgpt.com"],
      name: expect.stringMatching(/^responder_chatgpt_21212121212141218121212121212121_[a-f0-9]{8}$/u),
      value: "access",
    }));
  });

  it("deletes the secret, treating a missing one as deleted", async () => {
    daytonaSecrets.delete.mockResolvedValueOnce(undefined);
    await deleteSubscriptionRunSecret("secret-1", environment);
    expect(daytonaSecrets.delete).toHaveBeenCalledWith("secret-1");
    daytonaSecrets.delete.mockRejectedValueOnce(Object.assign(new Error("Not found"), { statusCode: 404 }));
    await expect(deleteSubscriptionRunSecret("secret-2", environment)).resolves.toBeUndefined();
  });
});
