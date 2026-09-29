import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSubscriptionAuth, runOnlyRefreshToken } from "@responder/core/automations/chatgpt-subscription";
import { SubscriptionCredentialUnavailableError } from "@responder/core/db/automation-model-credentials";
import { describe, expect, it, vi } from "vitest";
import {
  subscriptionAuthCoveringRun,
  subscriptionRefreshRunner,
  type SubscriptionAccessDependencies,
} from "./subscription-access.js";

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
    deps.getAuthJson.mockResolvedValue(authExpiringAt(new Date(now.getTime() + 24 * 3_600_000)));
    const authJson = await subscriptionAuthCoveringRun(owner, validUntil, deps);
    expect(parseSubscriptionAuth(authJson).tokens.refresh_token).toBe(runOnlyRefreshToken);
    expect(authJson).not.toContain("stored-refresh");
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it("refreshes a login that would expire during the run", async () => {
    const deps = dependencies();
    deps.getAuthJson
      .mockResolvedValueOnce(authExpiringAt(new Date(now.getTime() + 30 * 60_000)))
      .mockResolvedValueOnce(authExpiringAt(new Date(now.getTime() + 240 * 3_600_000)));
    await expect(subscriptionAuthCoveringRun(owner, validUntil, deps)).resolves.toContain(runOnlyRefreshToken);
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
    deps.getAuthJson
      .mockResolvedValueOnce(authExpiringAt(new Date(now.getTime() + 30 * 60_000)))
      .mockResolvedValueOnce(authExpiringAt(new Date(now.getTime() + 240 * 3_600_000)));
    deps.refresh.mockRejectedValueOnce(new SubscriptionCredentialUnavailableError());
    await expect(subscriptionAuthCoveringRun(owner, validUntil, deps)).resolves.toContain(runOnlyRefreshToken);
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
