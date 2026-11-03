import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireSandboxConfig, sandboxHome, sandboxWorkspaceRoot } from "@responder/core/sandbox-config";
import { expect, it, vi } from "vitest";
import {
  automationSandboxReadyMarker,
  runInFreshAutomationSandbox,
  type PausedAutomationSandbox,
} from "./automation-sandbox.js";
import {
  codexCliVersion,
  prepareCodexAutomationHarness,
  subscriptionPermissionConfig,
} from "./codex-automation-harness.js";
import { prepareDaytonaSandbox } from "./sandbox.js";
import {
  applySandboxNetwork,
  closeSandbox,
  configureSandbox,
  createSandboxSession,
  deleteSandboxByName,
  replaceSandboxSecrets,
} from "./sandbox-runtime.js";
import { downloadVercelSandboxFile, uploadVercelSandboxFile } from "./vercel-sandbox.js";
import type { VercelSandboxSession } from "@openai/agents-extensions/sandbox/vercel";

// Opt-in: runs two turns in disposable sandboxes with a synthetic secret, sent
// to a public echo service. Run with LIVE_VERCEL_SANDBOX_TEST=1,
// SANDBOX_PROVIDER=vercel, and the VERCEL_* settings of a test project. Set
// VERCEL_SANDBOX_COUNTRY to check where the sandbox runs.
const echoHost = "postman-echo.com";
const secretValue = `synthetic-${randomBytes(8).toString("hex")}`;
const dependencies = {
  applyNetwork: applySandboxNetwork,
  close: closeSandbox,
  closePending: deleteSandboxByName,
  configure: configureSandbox,
  createClient: () => { throw new Error("Vercel uses its own client"); },
  createSession: createSandboxSession,
  meter: () => ({ stop: () => Promise.resolve() }),
  prepare: prepareDaytonaSandbox,
  replaceSecrets: replaceSandboxSecrets,
};
const secrets = [{
  allowedHosts: [echoHost],
  daytonaSecretName: null,
  environmentVariable: "SERVICE_KEY",
  value: secretValue,
}];

function runId(): string {
  return `live-${randomBytes(6).toString("hex")}`;
}

it.skipIf(process.env.LIVE_VERCEL_SANDBOX_TEST !== "1")("pauses, resumes, and keeps secret values out of the sandbox", async () => {
  const config = requireSandboxConfig();
  const brokerToken = "synthetic-broker-token";
  const id = runId();
  let paused: PausedAutomationSandbox | undefined;

  await runInFreshAutomationSandbox({
    brokerToken,
    config,
    keepPaused: true,
    onPaused: (sandbox) => { paused = sandbox; },
    organizationId: "00000000-0000-4000-8000-000000000000",
    run: async (session, _withBroker, _signal, resumed) => {
      expect(resumed).toBe(false);
      const exec = (cmd: string) => session.execCommand({ cmd, workdir: sandboxWorkspaceRoot, yieldTimeMs: 150_000 });
      const tools = await exec(`for tool in rg bun pnpm git node python3 curl; do command -v $tool >/dev/null || echo missing-$tool; done; ls /opt/responder`);
      expect(tools).toContain("Process exited with code 0");
      expect(tools).not.toContain("missing-");
      expect(tools).toContain("codex");

      const location = await exec(`cat /proc/version; curl -sS -m 20 https://ipinfo.io/country`);
      expect(location).toContain("6.18.56");
      if (process.env.VERCEL_SANDBOX_COUNTRY) expect(location).toContain(process.env.VERCEL_SANDBOX_COUNTRY);

      const sees = await exec(`printenv SERVICE_KEY`);
      expect(sees).toContain("dtn_secret_");
      expect(sees).not.toContain(secretValue);

      const injected = await exec(`curl -sS -m 20 -H "Authorization: Bearer $SERVICE_KEY" https://${echoHost}/headers`);
      expect(injected).toContain(secretValue);
      const elsewhere = await exec(`curl -sS -m 20 -H "Authorization: Bearer $SERVICE_KEY" https://httpbingo.org/headers`);
      // The echo service answered, so the placeholder left the sandbox as is.
      expect(elsewhere).toMatch(/authorization/i);
      expect(elsewhere).not.toContain(secretValue);

      // Agents run commands that outlast a single HTTP request.
      const slow = await exec(`sleep 75; echo slow-command-done`);
      expect(slow).toContain("slow-command-done");

      const directory = await mkdtemp(join(tmpdir(), "vercel-upload-"));
      try {
        const content = randomBytes(70 * 1024 * 1024);
        const local = join(directory, "archive.bin");
        await writeFile(local, content);
        const remote = `${sandboxWorkspaceRoot}/.responder/archive.bin`;
        await uploadVercelSandboxFile(session as VercelSandboxSession, local, remote);
        const downloaded = await downloadVercelSandboxFile(session as VercelSandboxSession, remote);
        expect(createHash("sha256").update(downloaded).digest("hex"))
          .toBe(createHash("sha256").update(content).digest("hex"));
        await exec(`rm -f ${remote}`);
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
      await session.materializeEntry({
        entry: { type: "file", content: "ready" },
        path: automationSandboxReadyMarker,
      });
    },
    runId: id,
    secrets,
  }, dependencies as never);

  expect(paused).toBeDefined();
  const saved = JSON.stringify(paused?.sessionState);
  expect(saved).not.toContain(secretValue);
  expect(saved).not.toContain(process.env.VERCEL_TOKEN);
  expect(saved).not.toContain(brokerToken);

  await runInFreshAutomationSandbox({
    brokerToken,
    config,
    organizationId: "00000000-0000-4000-8000-000000000000",
    resumeState: paused?.sessionState,
    run: async (session, _withBroker, _signal, resumed) => {
      expect(resumed).toBe(true);
      const injected = await session.execCommand({
        cmd: `curl -sS -m 20 -H "Authorization: Bearer $SERVICE_KEY" https://${echoHost}/headers`,
        workdir: sandboxWorkspaceRoot,
      });
      expect(injected).toContain(secretValue);
    },
    runId: id,
    secrets,
  }, dependencies as never);
}, 420_000);

it.skipIf(process.env.LIVE_VERCEL_SANDBOX_TEST !== "1")("starts fresh from a state saved on Daytona", async () => {
  const config = requireSandboxConfig();
  const run = vi.fn(async (_session: unknown, _broker: unknown, _signal: unknown, resumed: boolean) => {
    expect(resumed).toBe(false);
  });
  await runInFreshAutomationSandbox({
    brokerToken: "synthetic-broker-token",
    config,
    organizationId: "00000000-0000-4000-8000-000000000000",
    resumeState: { apiUrl: "https://app.daytona.io", sandboxId: "daytona-sandbox" },
    run,
    runId: runId(),
  }, dependencies as never);
  expect(run).toHaveBeenCalledOnce();
}, 120_000);

it.skipIf(process.env.LIVE_VERCEL_SANDBOX_TEST !== "1")("enforces the native credential boundary", async () => {
  const config = requireSandboxConfig();
  await runInFreshAutomationSandbox({
    brokerToken: "synthetic-broker-token",
    config,
    organizationId: "00000000-0000-4000-8000-000000000000",
    run: async (session) => {
      const authDirectory = `${sandboxHome}/.responder-subscription-auth`;
      const exec = (cmd: string) => session.execCommand({ cmd, workdir: sandboxWorkspaceRoot, yieldTimeMs: 60_000 });
      const ready = await exec(`sudo -n mkdir -p ${authDirectory}; sudo -n chmod 755 ${sandboxHome}; sudo -n chown root:root ${sandboxWorkspaceRoot}; printf synthetic-secret | sudo -n tee ${authDirectory}/auth.json >/dev/null`);
      expect(ready).toContain("Process exited with code 0");
      await prepareCodexAutomationHarness(session, true);
      const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
      const executable = `/opt/responder/codex/${codexCliVersion}/node_modules/.bin/codex`;
      const prefix = `sudo -n --preserve-env=PATH -- ${executable} sandbox --permission-profile subscription ${subscriptionPermissionConfig.flatMap((value) => ["--config", quote(value)]).join(" ")} -- /bin/sh -c `;
      for (const [command, succeeds] of [
        [`echo ok > ${sandboxWorkspaceRoot}/result && cat ${sandboxWorkspaceRoot}/result`, true],
        [`cat ${authDirectory}/auth.json`, false],
        [`ln -s ${authDirectory}/auth.json ${sandboxWorkspaceRoot}/cache; cat ${sandboxWorkspaceRoot}/cache`, false],
        [`echo replaced > ${executable}`, false],
        [`sudo -n cat ${authDirectory}/auth.json`, false],
      ] as const) {
        const result = await exec(prefix + quote(command));
        expect(result.includes("Process exited with code 0"), result).toBe(succeeds);
        expect(result).not.toContain("synthetic-secret");
      }
    },
    runId: runId(),
  }, dependencies as never);
}, 180_000);
