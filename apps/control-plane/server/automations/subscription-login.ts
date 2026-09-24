import { Daytona } from "@daytona/sdk";
import { z } from "zod";
import { daytonaClientOptions, requireDaytonaClientConfig, isDaytonaNotFound } from "../../../../packages/core/src/daytona-config.js";
import { parseSubscriptionAuth, subscriptionCliVersion, type SubscriptionLoginTransport } from "../../../../packages/core/src/automations/chatgpt-subscription.js";

export class SubscriptionLoginError extends Error {
  constructor(readonly stage: "sandbox" | "status" | "authorization" | "credentials", readonly retryable: boolean) {
    super(stage === "authorization" ? "ChatGPT did not complete authorization. Start a new connection and approve the device code." : stage === "credentials" ? "ChatGPT authorization completed, but the credential cache could not be loaded." : "Could not reach the sign-in sandbox. Retrying…");
  }
}
const root = "/home/daytona/.responder-subscription-login";
// The managed app server owns OAuth, PKCE, token exchange, and token refresh.
// Status files contain only UI state. Credential files are read through the SDK,
// never through a shell command or process output.
export const subscriptionLoginRunner = `
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, renameSync } from "node:fs";
const root = ${JSON.stringify(root)};
const status = (value) => { writeFileSync(root + "/status.tmp", JSON.stringify(value), { mode: 0o600 }); renameSync(root + "/status.tmp", root + "/status.json"); };
status({ status: "starting" });
const child = spawn(root + "/node_modules/.bin/codex", ["app-server", "--config", 'cli_auth_credentials_store="file"'], { env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root + "/auth" }, stdio: ["pipe", "pipe", "ignore"] });
const send = (value) => child.stdin.write(JSON.stringify(value) + "\\n");
let done = false;
let loginId;
const fail = () => { if (!done) { done = true; status({ status: "failed" }); child.kill(); } };
const timeout = setTimeout(fail, 15 * 60 * 1000);
child.on("error", fail);
child.on("exit", () => { clearTimeout(timeout); if (!done) fail(); });
createInterface({ input: child.stdout }).on("line", (line) => {
  try {
    if (line.length > 1048576) return fail();
    const message = JSON.parse(line);
    if (message.error) return fail();
    if (message.id === 1) {
      send({ method: "initialized" });
      send({ id: 2, method: "account/login/start", params: { type: "chatgptDeviceCode" } });
    } else if (message.id === 2) {
      loginId = message.result.loginId;
      status({ status: "pending", userCode: message.result.userCode, verificationUrl: message.result.verificationUrl });
    } else if (message.method === "account/login/completed" && message.params.loginId === loginId) {
      if (!message.params.success) return fail();
      done = true; status({ status: "connected" }); clearTimeout(timeout); child.kill();
    }
  } catch { fail(); }
});
send({ id: 1, method: "initialize", params: { clientInfo: { name: "responder", version: "1.0.0" }, capabilities: {} } });
`;
const statusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("starting") }),
  z.object({ status: z.literal("pending"), userCode: z.string().min(1).max(64), verificationUrl: z.string().url().refine((value) => new URL(value).origin === "https://auth.openai.com") }),
  z.object({ status: z.literal("connected") }),
  z.object({ status: z.literal("failed") }),
]);
function client() { return new Daytona(daytonaClientOptions(requireDaytonaClientConfig())); }
export const subscriptionLoginTransport: SubscriptionLoginTransport = {
  async start() {
    const config = requireDaytonaClientConfig();
    const sdk = client();
    let sandbox;
    try {
      sandbox = await sdk.create({ snapshot: config.sandboxSnapshotName, name: `responder-login-${crypto.randomUUID()}`, ephemeral: true, autoStopInterval: 20, autoDeleteInterval: 0 }, { timeout: 60 });
      const setup = await sandbox.process.executeCommand(`umask 077; mkdir -p ${root}/auth; npm install --prefix ${root} --ignore-scripts --no-audit --no-fund --no-package-lock --no-save @openai/codex@${subscriptionCliVersion}`, undefined, undefined, 60);
      if (setup.exitCode !== 0) throw new Error("Unable to prepare subscription sign-in");
      await sandbox.fs.uploadFile(Buffer.from(subscriptionLoginRunner), `${root}/login.mjs`);
      await sandbox.process.createSession("subscription-login");
      await sandbox.process.executeSessionCommand("subscription-login", { command: `node ${root}/login.mjs`, runAsync: true });
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        let status;
        try { status = statusSchema.parse(JSON.parse((await sandbox.fs.downloadFile(`${root}/status.json`)).toString())); }
        catch { continue; }
        if (status.status === "failed") throw new Error("Unable to start ChatGPT sign-in");
        if (status.status === "pending") return { sandboxId: sandbox.id, userCode: status.userCode, verificationUrl: status.verificationUrl };
      }
      throw new Error("Subscription sign-in timed out");
    } catch (error) {
      if (sandbox) await sdk.delete(sandbox).catch(() => {});
      throw error;
    } finally { await sdk[Symbol.asyncDispose](); }
  },
  async poll(sandboxId) {
    const sdk = client();
    try {
      const sandbox = await sdk.get(sandboxId).catch(() => { throw new SubscriptionLoginError("sandbox", true); });
      const status = await sandbox.fs.downloadFile(`${root}/status.json`)
        .then(buffer => statusSchema.parse(JSON.parse(buffer.toString())))
        .catch(() => { throw new SubscriptionLoginError("status", true); });
      if (status.status === "failed") throw new SubscriptionLoginError("authorization", false);
      if (status.status !== "connected") return { status: "pending" };
      try {
        const authJson = (await sandbox.fs.downloadFile(`${root}/auth/auth.json`)).toString();
        parseSubscriptionAuth(authJson);
        return { status: "connected", authJson };
      } catch { throw new SubscriptionLoginError("credentials", false); }
    } finally { await sdk[Symbol.asyncDispose](); }
  },
  async cancel(sandboxId) {
    const sdk = client();
    try { await sdk.delete(await sdk.get(sandboxId)); }
    catch (error) { if (!isDaytonaNotFound(error)) throw error; }
    finally { await sdk[Symbol.asyncDispose](); }
  },
};
