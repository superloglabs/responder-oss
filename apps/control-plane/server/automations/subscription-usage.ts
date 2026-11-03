import { z } from "zod";
import { createModelCatalogCache } from "./model-catalog-cache.js";
import { runSubscriptionClient } from "./subscription-models.js";

const root = "/home/daytona/.responder-subscription-usage";
// The managed client reads the subscription's rate limits, refreshing its own
// login first when it needs to.
export const subscriptionUsageRunner = `
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const root = ${JSON.stringify(root)};
const child = spawn(root + "/node_modules/.bin/codex", ["app-server", "--config", 'cli_auth_credentials_store="file"'], { env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root + "/auth" }, stdio: ["pipe", "pipe", "ignore"] });
const send = (value) => child.stdin.write(JSON.stringify(value) + "\\n");
let done = false;
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
      send({ id: 3, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
    } else if (message.id === 3) {
      const limits = message.result.rateLimits ?? {};
      writeFileSync(root + "/usage.json", JSON.stringify({ planType: limits.planType ?? null, windows: [limits.primary, limits.secondary].filter(Boolean) }), { mode: 0o600 });
      done = true; clearTimeout(timer); child.kill();
    }
  } catch { fail(); }
});
send({ id: 1, method: "initialize", params: { clientInfo: { name: "responder", version: "1.0.0" }, capabilities: {} } });
`;

const usageSchema = z.object({
  planType: z.string().max(100).nullable(),
  windows: z.array(z.object({
    // Unix seconds.
    resetsAt: z.number().int().nonnegative().nullable(),
    usedPercent: z.number().finite(),
    windowDurationMins: z.number().int().positive().nullable(),
  })).max(10),
});

export interface SubscriptionUsage {
  planType: string | null;
  windows: Array<{
    // Milliseconds since the epoch.
    resetsAt: number | null;
    usedPercent: number;
    windowMinutes: number | null;
  }>;
}

export function parseSubscriptionUsage(value: string): SubscriptionUsage {
  const usage = usageSchema.parse(JSON.parse(value));
  return {
    planType: usage.planType,
    windows: usage.windows.map((window) => ({
      resetsAt: window.resetsAt === null ? null : window.resetsAt * 1_000,
      usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
      windowMinutes: window.windowDurationMins,
    })),
  };
}

async function loadSubscriptionUsage(owner: { organizationId: string; credentialId: string }) {
  return parseSubscriptionUsage(
    await runSubscriptionClient(owner, { name: "usage", output: "usage.json", root, runner: subscriptionUsageRunner }),
  );
}

// Each read starts a sandbox, so members share one read per subscription for
// five minutes.
const usageCache = createModelCatalogCache<SubscriptionUsage>();
export function readSubscriptionUsage(owner: { organizationId: string; credentialId: string }) {
  return usageCache(`${owner.organizationId}:${owner.credentialId}`, () => loadSubscriptionUsage(owner));
}
