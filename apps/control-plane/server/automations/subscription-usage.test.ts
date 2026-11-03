import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseSubscriptionUsage, subscriptionUsageRunner } from "./subscription-usage.js";

describe("subscriptionUsageRunner", () => {
  it("reads rate limits through managed authentication", async () => {
    const root = await mkdtemp(join(tmpdir(), "responder-usage-test-"));
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
 if (message.method === "account/rateLimits/read") send(message.id, { rateLimits: {
   planType: "pro",
   primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1762180000 },
   secondary: { usedPercent: 7.5, windowDurationMins: 10080, resetsAt: 1762700000 },
 } });
});
`, { mode: 0o700 });
      await writeFile(join(root, "usage.mjs"), subscriptionUsageRunner.replaceAll("/home/daytona/.responder-subscription-usage", root));
      const child = spawn("node", [join(root, "usage.mjs")], { stdio: "ignore" });
      await new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error("Usage read failed"))); });
      expect(parseSubscriptionUsage(await readFile(join(root, "usage.json"), "utf8"))).toEqual({
        planType: "pro",
        windows: [
          { resetsAt: 1762180000000, usedPercent: 42, windowMinutes: 300 },
          { resetsAt: 1762700000000, usedPercent: 7.5, windowMinutes: 10080 },
        ],
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("parseSubscriptionUsage", () => {
  it("keeps the used share between 0 and 100", () => {
    expect(parseSubscriptionUsage(JSON.stringify({
      planType: null,
      windows: [{ resetsAt: null, usedPercent: 130, windowDurationMins: null }],
    })).windows).toEqual([{ resetsAt: null, usedPercent: 100, windowMinutes: null }]);
  });
});
