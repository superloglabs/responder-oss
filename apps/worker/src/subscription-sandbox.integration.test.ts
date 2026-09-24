import { Daytona } from "@daytona/sdk";
import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { daytonaClientOptions, requireDaytonaClientConfig } from "@responder/core/daytona-config";
import { expect, it } from "vitest";
import { codexCliVersion, prepareCodexAutomationHarness, subscriptionPermissionConfig } from "./codex-automation-harness.js";

// Opt-in: creates one disposable sandbox, uses synthetic credentials, and makes
// no inference requests. Run with LIVE_SUBSCRIPTION_SANDBOX_TEST=1 and runtime env.
it.skipIf(process.env.LIVE_SUBSCRIPTION_SANDBOX_TEST !== "1")("enforces the native credential boundary in the deployed sandbox runtime", async () => {
  const config = requireDaytonaClientConfig();
  const sdk = new Daytona(daytonaClientOptions(config));
  let sandbox;
  try {
    sandbox = await sdk.create({ snapshot: config.sandboxSnapshotName, ephemeral: true, autoStopInterval: 5, autoDeleteInterval: 0 }, { timeout: 60 });
    const ready = await sandbox.process.executeCommand("sudo -n mkdir -p /home/daytona/workspace /home/daytona/.responder-subscription-auth; sudo -n chmod 755 /home/daytona; sudo -n chown root:root /home/daytona/workspace; printf synthetic-secret | sudo -n tee /home/daytona/.responder-subscription-auth/auth.json >/dev/null", undefined, undefined, 20);
    expect(ready.exitCode).toBe(0);
    const activeSandbox = sandbox;
    const session = { execCommand: async ({ cmd, workdir }: { cmd: string; workdir: string }) => {
      const result = await activeSandbox.process.executeCommand(cmd, workdir, undefined, 60);
      return `Process exited with code ${result.exitCode}\n${result.result}`;
    } } as unknown as DaytonaSandboxSession;
    await prepareCodexAutomationHarness(session, true);
    const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
    const executable = `/opt/responder/codex/${codexCliVersion}/node_modules/.bin/codex`;
    const prefix = `sudo -n --preserve-env=PATH -- ${executable} sandbox --permission-profile subscription ${subscriptionPermissionConfig.flatMap(value => ["--config", quote(value)]).join(" ")} -- /bin/sh -c `;
    for (const [command, succeeds] of [
      ["echo ok > /home/daytona/workspace/result && cat /home/daytona/workspace/result", true],
      ["cat /home/daytona/.responder-subscription-auth/auth.json", false],
      ["ln -s /home/daytona/.responder-subscription-auth/auth.json /home/daytona/workspace/cache; cat /home/daytona/workspace/cache", false],
      [`echo replaced > ${executable}`, false],
      ["sudo -n cat /home/daytona/.responder-subscription-auth/auth.json", false],
    ] as const) {
      const result = await sandbox.process.executeCommand(prefix + quote(command), "/home/daytona/workspace", undefined, 20);
      expect(result.exitCode === 0, result.result).toBe(succeeds);
      expect(result.result).not.toContain("synthetic-secret");
    }
  } finally {
    try { if (sandbox) await sdk.delete(sandbox); }
    finally { await sdk[Symbol.asyncDispose](); }
  }
}, 180_000);
