import { createModelCatalogCache } from "./model-catalog-cache.js";
import { Daytona } from "@daytona/sdk";
import { z } from "zod";
import { daytonaClientOptions, requireDaytonaClientConfig } from "../../../../packages/core/src/daytona-config.js";
import { parseSubscriptionAuth, subscriptionCliVersion } from "../../../../packages/core/src/automations/chatgpt-subscription.js";
import { acquireSubscriptionCredential, persistSubscriptionCredential, releaseSubscriptionCredential } from "../../../../packages/core/src/db/automation-model-credentials.js";

const root = "/home/daytona/.responder-model-catalog";
// The managed client discovers subscription models and refreshes its own credentials.
export const subscriptionModelsRunner = `
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const root = ${JSON.stringify(root)};
const child = spawn(root + "/node_modules/.bin/codex", ["app-server", "--config", 'cli_auth_credentials_store="file"'], { env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root + "/auth" }, stdio: ["pipe", "pipe", "ignore"] });
const send = (value) => child.stdin.write(JSON.stringify(value) + "\\n");
const models = [];
let done = false;
let pages = 0;
const fail = () => { if (!done) { done = true; process.exitCode = 1; child.kill(); } };
const timer = setTimeout(fail, 45000);
child.on("error", fail);
child.on("exit", () => { clearTimeout(timer); if (!done) fail(); });
createInterface({ input: child.stdout }).on("line", line => {
  try {
    if (line.length > 1048576) return fail();
    const message = JSON.parse(line);
    if (message.error) return fail();
    if (message.id === 1) {
      send({ method: "initialized" });
      send({ id: 2, method: "account/read", params: { refreshToken: true } });
    } else if (message.id === 2) {
      if (message.result.account?.type !== "chatgpt") return fail();
      send({ id: 3, method: "model/list", params: { limit: 100, includeHidden: false } });
    } else if (message.id === 3) {
      for (const model of message.result.data) if (!model.hidden) models.push({ id: model.model, name: model.displayName });
      if (message.result.nextCursor) {
        if (++pages > 100) return fail();
        send({ id: 3, method: "model/list", params: { limit: 100, includeHidden: false, cursor: message.result.nextCursor } });
      } else {
        writeFileSync(root + "/models.json", JSON.stringify(models), { mode: 0o600 });
        done = true; clearTimeout(timer); child.kill();
      }
    }
  } catch { fail(); }
});
send({ id: 1, method: "initialize", params: { clientInfo: { name: "responder", version: "1.0.0" }, capabilities: {} } });
`;
const modelsSchema = z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/u), name: z.string().min(1) })).max(10000);
async function loadSubscriptionModels(owner: { organizationId: string; credentialId: string }) {
  const lease = { ...owner, leaseId: crypto.randomUUID() };
  const config = requireDaytonaClientConfig();
  const sdk = new Daytona(daytonaClientOptions(config));
  let sandbox;
  let originalAccountId: string | undefined;
  try {
    const authJson = await acquireSubscriptionCredential({ ...lease, expiresAt: new Date(Date.now() + 180_000) });
    originalAccountId = parseSubscriptionAuth(authJson).tokens.account_id;
    sandbox = await sdk.create({ snapshot: config.sandboxSnapshotName, name: `responder-models-${crypto.randomUUID()}`, ephemeral: true, autoStopInterval: 5, autoDeleteInterval: 0 }, { timeout: 60 });
    const setup = await sandbox.process.executeCommand(`umask 077; mkdir -p ${root}/auth; chmod 700 ${root}/auth; npm install --prefix ${root} --ignore-scripts --no-audit --no-fund --no-package-lock --no-save @openai/codex@${subscriptionCliVersion}`, undefined, undefined, 60);
    if (setup.exitCode !== 0) throw new Error("Unable to prepare model discovery");
    await sandbox.fs.uploadFile(Buffer.from(authJson), `${root}/auth/auth.json`);
    await sandbox.fs.uploadFile(Buffer.from(subscriptionModelsRunner), `${root}/models.mjs`);
    const result = await sandbox.process.executeCommand(`chmod 600 ${root}/auth/auth.json; node ${root}/models.mjs`, undefined, undefined, 55);
    if (result.exitCode !== 0) throw new Error("Unable to discover subscription models");
    return modelsSchema.parse(JSON.parse((await sandbox.fs.downloadFile(`${root}/models.json`)).toString()));
  } finally {
    try {
      if (sandbox && originalAccountId) {
        // Preserve managed refreshes even if model discovery itself failed.
        const updated = await sandbox.fs.downloadFile(`${root}/auth/auth.json`).catch(() => null);
        if (updated) await persistSubscriptionCredential({ ...lease, authJson: updated.toString(), previousAccountId: originalAccountId });
      }
    } finally {
      try { if (sandbox) await sdk.delete(sandbox); }
      finally { await releaseSubscriptionCredential(lease); await sdk[Symbol.asyncDispose](); }
    }
  }
}

const catalogCache = createModelCatalogCache();
export function listSubscriptionModels(owner: { organizationId: string; credentialId: string }, refresh = false) {
  return catalogCache(`${owner.organizationId}:${owner.credentialId}`, () => loadSubscriptionModels(owner), refresh);
}
