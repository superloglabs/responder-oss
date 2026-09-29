import { Daytona, type Sandbox } from "@daytona/sdk";
import {
  parseSubscriptionAuth,
  subscriptionAccessTokenExpiresAt,
  subscriptionAuthForRun,
  subscriptionCliVersion,
} from "@responder/core/automations/chatgpt-subscription";
import {
  acquireSubscriptionCredential,
  getOrganizationModelCredential,
  persistSubscriptionCredential,
  releaseSubscriptionCredential,
  SubscriptionCredentialUnavailableError,
} from "@responder/core/db/automation-model-credentials";
import { daytonaClientOptions, requireDaytonaClientConfig } from "@responder/core/daytona-config";
import { prebuiltHarnessRoot } from "./automation-harness.js";

interface SubscriptionOwner {
  credentialId: string;
  organizationId: string;
}

const root = "/home/daytona/.responder-subscription-refresh";
const prebuiltExecutable = `${prebuiltHarnessRoot}/codex/${subscriptionCliVersion}/node_modules/.bin/codex`;
const installedExecutable = `${root}/node_modules/.bin/codex`;

// The official client refreshes its own login; Responder never calls the
// provider token endpoint. `account/read` reports success even when the
// refresh fails, so callers check the stored expiry afterwards.
export const subscriptionRefreshRunner = `
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const root = ${JSON.stringify(root)};
const child = spawn(process.argv[2], ["app-server", "--config", 'cli_auth_credentials_store="file"'], { env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root + "/auth" }, stdio: ["pipe", "pipe", "ignore"] });
const send = (value) => child.stdin.write(JSON.stringify(value) + "\\n");
let done = false;
const finish = (code) => { if (!done) { done = true; process.exitCode = code; clearTimeout(timer); child.kill(); } };
const timer = setTimeout(() => finish(1), 45000);
child.on("error", () => finish(1));
child.on("exit", () => finish(1));
createInterface({ input: child.stdout }).on("line", line => {
  try {
    if (line.length > 1048576) return finish(1);
    const message = JSON.parse(line);
    if (message.error) return finish(1);
    if (message.id === 1) {
      send({ method: "initialized" });
      send({ id: 2, method: "account/read", params: { refreshToken: true } });
    } else if (message.id === 2) {
      finish(message.result.account?.type === "chatgpt" ? 0 : 1);
    }
  } catch { finish(1); }
});
send({ id: 1, method: "initialize", params: { clientInfo: { name: "responder", version: "1.0.0" }, capabilities: {} } });
`;

// Holds the lease only while the official client rotates the refresh token, in
// a short-lived sandbox of its own.
export async function refreshSubscriptionInSandbox(
  owner: SubscriptionOwner,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = requireDaytonaClientConfig(environment);
  const sdk = new Daytona(daytonaClientOptions(config));
  const lease = { ...owner, leaseId: crypto.randomUUID() };
  let sandbox: Sandbox | undefined;
  let leased = false;
  let originalAccountId: string | undefined;
  try {
    sandbox = await sdk.create({ snapshot: config.sandboxSnapshotName, name: `responder-refresh-${crypto.randomUUID()}`, ephemeral: true, autoStopInterval: 5, autoDeleteInterval: 0 }, { timeout: 60 });
    const setup = await sandbox.process.executeCommand(`set -e; umask 077; mkdir -p ${root}/auth; chmod 700 ${root}/auth; if [ -x ${prebuiltExecutable} ]; then ln -sf ${prebuiltExecutable} ${root}/codex; else npm install --prefix ${root} --ignore-scripts --no-audit --no-fund --no-package-lock --no-save @openai/codex@${subscriptionCliVersion}; ln -sf ${installedExecutable} ${root}/codex; fi`, undefined, undefined, 60);
    if (setup.exitCode !== 0) throw new Error("Unable to prepare the subscription refresh");
    await sandbox.fs.uploadFile(Buffer.from(subscriptionRefreshRunner), `${root}/refresh.mjs`);
    const authJson = await acquireSubscriptionCredential({ ...lease, expiresAt: new Date(Date.now() + 120_000) });
    leased = true;
    originalAccountId = parseSubscriptionAuth(authJson).tokens.account_id;
    await sandbox.fs.uploadFile(Buffer.from(authJson), `${root}/auth/auth.json`);
    const result = await sandbox.process.executeCommand(`chmod 600 ${root}/auth/auth.json; node ${root}/refresh.mjs ${root}/codex`, undefined, undefined, 55);
    if (result.exitCode !== 0) throw new Error("Unable to refresh the ChatGPT subscription");
  } finally {
    try {
      if (sandbox && originalAccountId) {
        // Keep a rotated token even if the runner failed after rotating it.
        const updated = await sandbox.fs.downloadFile(`${root}/auth/auth.json`).catch(() => null);
        if (updated) await persistSubscriptionCredential({ ...lease, authJson: updated.toString(), previousAccountId: originalAccountId });
      }
    } finally {
      try {
        if (sandbox) await sdk.delete(sandbox);
        // Do not hand the refresh token to another operation unless this sandbox is gone.
        if (leased) await releaseSubscriptionCredential(lease);
      } finally { await sdk[Symbol.asyncDispose](); }
    }
  }
}

export interface SubscriptionAccessDependencies {
  getAuthJson: (owner: SubscriptionOwner) => Promise<string | null>;
  now: () => Date;
  refresh: (owner: SubscriptionOwner) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

export const defaultSubscriptionAccessDependencies: SubscriptionAccessDependencies = {
  getAuthJson: async (owner) => (await getOrganizationModelCredential(owner))?.subscription?.authJson ?? null,
  now: () => new Date(),
  refresh: (owner) => refreshSubscriptionInSandbox(owner),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const refreshRetryMs = 5_000;
const refreshWaitLimitMs = 240_000;

// Returns a run-only cache whose access token outlives the run. Runs share the
// login and never write it back, so any number can use it at once.
export async function subscriptionAuthCoveringRun(
  owner: SubscriptionOwner,
  validUntil: Date,
  dependencies: SubscriptionAccessDependencies = defaultSubscriptionAccessDependencies,
): Promise<string> {
  const deadline = dependencies.now().getTime() + refreshWaitLimitMs;
  let refreshed = false;
  for (;;) {
    const authJson = await dependencies.getAuthJson(owner);
    if (!authJson) throw new Error("The ChatGPT subscription is unavailable. Reconnect it in model settings.");
    const expiresAt = subscriptionAccessTokenExpiresAt(authJson);
    if (expiresAt && expiresAt > validUntil) return subscriptionAuthForRun(authJson);
    if (refreshed) throw new Error("ChatGPT did not renew the subscription login. Reconnect it in model settings.");
    try {
      await dependencies.refresh(owner);
      refreshed = true;
    } catch (error) {
      // Another operation is refreshing; its result may already cover this run.
      if (!(error instanceof SubscriptionCredentialUnavailableError) || dependencies.now().getTime() >= deadline) throw error;
      await dependencies.sleep(refreshRetryMs);
    }
  }
}
