import type {
  VercelSandboxClient,
  VercelSandboxSession,
} from "@openai/agents-extensions/sandbox/vercel";
import { Sandbox } from "@vercel/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptCredentials } from "@responder/core/credentials/encryption";
import type { VercelSandboxConfig } from "@responder/core/sandbox-config";
import { resumeSandbox, serializeSandboxSession } from "./sandbox-runtime.js";
import { containsDaytonaSecretPlaceholder } from "./secret-safety.js";
import {
  applyVercelSandboxSecrets,
  createVercelSandboxSession,
  resumedSameVercelSandbox,
  runVercelCommand,
  secretNetworkPolicy,
  vercelSecretPlaceholder,
} from "./vercel-sandbox.js";

vi.mock("@vercel/sandbox", () => ({ Sandbox: { create: vi.fn(), get: vi.fn() } }));

const config: VercelSandboxConfig = {
  region: "cdg1",
  sandboxSnapshotName: "snap_base",
  vercel: { projectId: "prj_1", teamId: "team_1", token: "vercel-token" },
};

function sessionWith(environment: Record<string, string>): VercelSandboxSession {
  return {
    state: { environment, sandboxId: "sbx_1", workspacePersistence: "snapshot" },
  } as unknown as VercelSandboxSession;
}

describe("secretNetworkPolicy", () => {
  const policy = secretNetworkPolicy([
    { allowedHosts: ["api.example.com"], placeholder: "ph-1", value: "real-1" },
    { allowedHosts: ["api.example.com", "*.other.dev"], placeholder: "ph-2", value: "real-2" },
  ]) as { allow: Record<string, Array<{ match: { headers: Array<{ key: { exact: string }; value: { exact: string } }> }; transform: Array<{ headers: Record<string, string> }> }>> };

  it("keeps other hosts reachable and limits each secret to its hosts", () => {
    expect(policy.allow["*"]).toEqual([]);
    expect(JSON.stringify(policy.allow["*.other.dev"])).toContain("real-2");
    expect(JSON.stringify(policy.allow["*.other.dev"])).not.toContain("real-1");
  });

  it("only rewrites requests that carry the placeholder", () => {
    const bearer = policy.allow["api.example.com"]!.find((rule) =>
      rule.match.headers[0]!.value.exact === "Bearer ph-1"
    );
    expect(bearer?.match.headers[0]?.key.exact).toBe("authorization");
    expect(bearer?.transform).toEqual([{ headers: { authorization: "Bearer real-1" } }]);
    for (const rule of policy.allow["api.example.com"]!) {
      expect(JSON.stringify(rule.match)).not.toContain("real-");
    }
  });
});

describe("secretNetworkPolicy for a restricted workspace", () => {
  const policy = secretNetworkPolicy(
    [{ allowedHosts: ["api.example.com"], placeholder: "ph-1", value: "real-1" }],
    { allowedDomains: ["superlog.sh", "*.npmjs.org"] },
  ) as { allow: Record<string, unknown[]> };

  it("allows only the listed domains and the secrets' hosts", () => {
    expect(Object.keys(policy.allow).sort()).toEqual([
      "*.npmjs.org",
      "api.example.com",
      "npmjs.org",
      "superlog.sh",
    ]);
    expect(policy.allow["superlog.sh"]).toEqual([]);
  });

  it("still swaps a secret's placeholder on its hosts", () => {
    expect(JSON.stringify(policy.allow["api.example.com"])).toContain("real-1");
  });

  it("swaps a wildcard secret's placeholder on the apex host too", () => {
    const wildcard = secretNetworkPolicy(
      [{ allowedHosts: ["*.example.com"], placeholder: "ph-1", value: "real-1" }],
      { allowedDomains: ["superlog.sh"] },
    ) as { allow: Record<string, unknown[]> };
    expect(JSON.stringify(wildcard.allow["*.example.com"])).toContain("real-1");
    expect(JSON.stringify(wildcard.allow["example.com"])).toContain("real-1");
  });
});

describe("vercelSecretPlaceholder", () => {
  it("is redacted like a Daytona placeholder and never repeats", () => {
    const placeholder = vercelSecretPlaceholder();
    expect(containsDaytonaSecretPlaceholder(placeholder)).toBe(true);
    expect(placeholder).not.toBe(vercelSecretPlaceholder());
  });
});

describe("applyVercelSandboxSecrets", () => {
  const updateNetworkPolicy = vi.fn();

  beforeEach(() => {
    updateNetworkPolicy.mockReset();
    vi.mocked(Sandbox.get).mockReset();
    vi.mocked(Sandbox.get).mockResolvedValue({ updateNetworkPolicy } as unknown as Awaited<ReturnType<typeof Sandbox.get>>);
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 1).toString("base64"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("puts the placeholder in the sandbox and the value in the firewall", async () => {
    const session = sessionWith({});
    await applyVercelSandboxSecrets(session, config, [{
      allowedHosts: ["api.example.com"],
      daytonaSecretName: null,
      encryptedValue: encryptCredentials({ value: "real-value" }),
      environmentVariable: "SERVICE_KEY",
    }]);
    const placeholder = session.state.environment.SERVICE_KEY!;
    expect(containsDaytonaSecretPlaceholder(placeholder)).toBe(true);
    expect(JSON.stringify(session.state)).not.toContain("real-value");
    expect(JSON.stringify(updateNetworkPolicy.mock.calls[0]?.[0])).toContain(`Bearer real-value`);
  });

  it("uses the placeholder a run token already carries", async () => {
    const session = sessionWith({});
    await applyVercelSandboxSecrets(session, config, [{
      allowedHosts: ["chatgpt.com"],
      daytonaSecretName: "",
      environmentVariable: "RESPONDER_CHATGPT_ACCESS_TOKEN",
      placeholder: "dtn_secret_run",
      value: "access-token",
    }]);
    expect(session.state.environment.RESPONDER_CHATGPT_ACCESS_TOKEN).toBe("dtn_secret_run");
  });

  it("removes secrets a later turn no longer uses", async () => {
    const session = sessionWith({ OLD_KEY: "dtn_secret_old", PLAIN: "kept" });
    await applyVercelSandboxSecrets(session, config, []);
    expect(session.state.environment).toEqual({ PLAIN: "kept" });
    expect(updateNetworkPolicy).toHaveBeenCalledWith({ allow: { "*": [] } });
  });

  it("restricts a sandbox that has no secrets", async () => {
    await applyVercelSandboxSecrets(sessionWith({}), config, [], { allowedDomains: ["superlog.sh"] });
    expect(updateNetworkPolicy).toHaveBeenCalledWith({ allow: { "superlog.sh": [] } });
  });

  it("makes no request when there are no secrets to apply or remove", async () => {
    await applyVercelSandboxSecrets(sessionWith({}), config, []);
    expect(Sandbox.get).not.toHaveBeenCalled();
  });

  it("refuses a secret saved before values were stored", async () => {
    await expect(applyVercelSandboxSecrets(sessionWith({}), config, [{
      allowedHosts: ["api.example.com"],
      daytonaSecretName: "dtn_old",
      encryptedValue: null,
      environmentVariable: "OLD_KEY",
    }])).rejects.toThrow("Workspace secret OLD_KEY must be saved again");
  });
});

describe("createVercelSandboxSession", () => {
  const noSleep = () => Promise.resolve();
  const stop = vi.fn().mockResolvedValue(undefined);
  const runCommand = vi.fn().mockResolvedValue({ exitCode: 0, output: () => Promise.resolve("") });
  const started = () => ({
    mkDir: vi.fn(),
    name: "sbx-new",
    runCommand,
    stop,
  }) as unknown as Awaited<ReturnType<typeof Sandbox.create>>;

  beforeEach(() => {
    stop.mockClear();
    vi.mocked(Sandbox.create).mockReset();
  });

  it("starts from the prebuilt snapshot in the configured region", async () => {
    vi.mocked(Sandbox.create).mockResolvedValue(started());
    const session = await createVercelSandboxSession(config, "tar", undefined, noSleep);
    expect(Sandbox.create).toHaveBeenCalledWith(expect.objectContaining({
      persistent: false,
      region: "cdg1",
      source: { snapshotId: "snap_base", type: "snapshot" },
    }));
    expect(session.state.sandboxId).toBe("sbx-new");
    expect(session.state.workspacePersistence).toBe("tar");
  });

  it("runs the session's commands detached", async () => {
    const finished = { exitCode: 0, output: () => Promise.resolve("") };
    const detachedRun = vi.fn().mockResolvedValue({ cmdId: "cmd_1", wait: () => Promise.resolve(finished) });
    const sandbox = { ...started(), runCommand: detachedRun };
    vi.mocked(Sandbox.create).mockResolvedValue(sandbox as unknown as Awaited<ReturnType<typeof Sandbox.create>>);
    await createVercelSandboxSession(config, "tar", undefined, noSleep);
    await expect(sandbox.runCommand({ args: ["-lc", "true"], cmd: "/bin/sh" })).resolves.toBe(finished);
    expect(detachedRun).toHaveBeenLastCalledWith({ args: ["-lc", "true"], cmd: "/bin/sh", detached: true });
  });

  it("retries a provider outage but not a rejected request", async () => {
    const outage = Object.assign(new Error("unavailable"), { response: { status: 503 } });
    const rejected = Object.assign(new Error("forbidden"), { response: { status: 403 } });
    vi.mocked(Sandbox.create).mockRejectedValueOnce(outage).mockResolvedValue(started());
    await expect(createVercelSandboxSession(config, "tar", undefined, noSleep)).resolves.toBeDefined();
    expect(Sandbox.create).toHaveBeenCalledTimes(2);

    vi.mocked(Sandbox.create).mockReset();
    vi.mocked(Sandbox.create).mockRejectedValue(rejected);
    await expect(createVercelSandboxSession(config, "tar", undefined, noSleep)).rejects.toBe(rejected);
    expect(Sandbox.create).toHaveBeenCalledTimes(1);
  });

  it("stops a sandbox that started after the caller gave up", async () => {
    const abort = new AbortController();
    vi.mocked(Sandbox.create).mockImplementation(async () => {
      abort.abort(new Error("cancelled"));
      return started();
    });
    await expect(createVercelSandboxSession(config, "tar", abort.signal, noSleep)).rejects.toThrow("cancelled");
    expect(stop).toHaveBeenCalled();
  });
});

describe("runVercelCommand", () => {
  const noSleep = () => Promise.resolve();
  const finished = { exitCode: 0, output: () => Promise.resolve("done\n") };
  const streamEnded = Object.assign(new Error("Stream ended before command finished"), {
    name: "StreamError",
  });

  function sandboxWithWaits(...waits: Array<() => Promise<unknown>>) {
    const wait = vi.fn();
    for (const next of waits) wait.mockImplementationOnce(next);
    const runCommand = vi.fn().mockResolvedValue({ cmdId: "cmd_1", wait });
    return { runCommand, wait, sandbox: { runCommand } as unknown as Sandbox };
  }

  it("starts the command detached", async () => {
    const { runCommand, sandbox } = sandboxWithWaits(() => Promise.resolve(finished));
    await expect(runVercelCommand(sandbox, { args: ["-lc", "codex exec"], cmd: "/bin/sh" }, noSleep))
      .resolves.toBe(finished);
    expect(runCommand).toHaveBeenCalledWith({ args: ["-lc", "codex exec"], cmd: "/bin/sh", detached: true });
  });

  it("waits again when the stream or connection drops", async () => {
    const { runCommand, sandbox, wait } = sandboxWithWaits(
      () => Promise.reject(streamEnded),
      () => Promise.reject(new TypeError("terminated")),
      () => Promise.reject(Object.assign(new Error("bad gateway"), { response: { status: 502 } })),
      () => Promise.reject(Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT" })),
      () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })),
      () => Promise.resolve(finished),
    );
    await expect(runVercelCommand(sandbox, { cmd: "/bin/sh" }, noSleep)).resolves.toBe(finished);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(6);
  });

  it("logs a wait that outlives the headers timeout as a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const headersTimeout = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
    });
    const { sandbox, wait } = sandboxWithWaits(
      () => Promise.reject(headersTimeout),
      () => Promise.resolve(finished),
    );
    try {
      await expect(runVercelCommand(sandbox, { cmd: "/bin/sh" }, noSleep)).resolves.toBe(finished);
      expect(wait).toHaveBeenCalledTimes(2);
      expect(error).not.toHaveBeenCalled();
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
        attempt: 1,
        cmdId: "cmd_1",
        error: "fetch failed",
        errorCode: "UND_ERR_HEADERS_TIMEOUT",
        event: "vercel_command_wait_retry",
      });
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("does not wait again after a rejected request or a cancellation", async () => {
    const rejected = Object.assign(new Error("not found"), { response: { status: 404 } });
    const first = sandboxWithWaits(() => Promise.reject(rejected));
    await expect(runVercelCommand(first.sandbox, { cmd: "/bin/sh" }, noSleep)).rejects.toBe(rejected);
    expect(first.wait).toHaveBeenCalledTimes(1);

    const abort = new AbortController();
    const second = sandboxWithWaits(() => {
      abort.abort();
      return Promise.reject(streamEnded);
    });
    await expect(runVercelCommand(second.sandbox, { cmd: "/bin/sh", signal: abort.signal }, noSleep))
      .rejects.toBe(streamEnded);
    expect(second.wait).toHaveBeenCalledTimes(1);
  });
});

describe("pausing and resuming", () => {
  it("keeps credentials and firewall rules out of the saved state", async () => {
    const snapshot = vi.fn().mockResolvedValue({ snapshotId: "snap_1" });
    vi.mocked(Sandbox.get).mockResolvedValue({ snapshot } as unknown as Awaited<ReturnType<typeof Sandbox.get>>);
    const session = sessionWith({});
    const client = {
      serializeSessionState: vi.fn().mockResolvedValue({
        environment: {},
        networkPolicy: { allow: { "api.example.com": [] } },
        projectId: "prj_1",
        sandboxId: "sbx_1",
        snapshotId: "snap_1",
        teamId: "team_1",
        token: "vercel-token",
        workspacePersistence: "snapshot",
      }),
    } as unknown as VercelSandboxClient;
    const state = await serializeSandboxSession(client, session, config);
    expect(state).toEqual({
      environment: {},
      sandboxId: "sbx_1",
      snapshotId: "snap_1",
      workspacePersistence: "snapshot",
    });
    expect(session.state).toMatchObject({ snapshotId: "snap_1", snapshotSandboxId: "sbx_1" });
  });

  it("keeps the turn when the snapshot fails, and the next turn starts fresh", async () => {
    const snapshot = vi.fn().mockRejectedValue(new Error("snapshot failed"));
    vi.mocked(Sandbox.get).mockResolvedValue({ snapshot } as unknown as Awaited<ReturnType<typeof Sandbox.get>>);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const session = sessionWith({});
    const client = {
      serializeSessionState: vi.fn(async (state: Record<string, unknown>) => ({ ...state })),
    } as unknown as VercelSandboxClient;
    const reportException = vi.fn().mockResolvedValue(undefined);

    const state = await serializeSandboxSession(
      client,
      session,
      config,
      { jobId: "run-1", organizationId: "org-1" },
      reportException,
    );

    expect(reportException).toHaveBeenCalledWith(expect.any(Error), {
      jobId: "run-1",
      operation: "sandbox_cleanup",
      organizationId: "org-1",
      sandboxId: "sbx_1",
    });
    expect(resumedSameVercelSandbox(state)).toBe(false);
  });

  it("refuses state saved by another provider so the run starts fresh", async () => {
    const client = {} as VercelSandboxClient;
    await expect(resumeSandbox(client, { sandboxId: "daytona-id" }, config)).rejects.toThrow(
      "paused on another provider",
    );
    await expect(resumeSandbox(
      {} as never,
      { sandboxId: "sbx_1", workspacePersistence: "snapshot" },
      { daytonaApiKey: "key" },
    )).rejects.toThrow("paused on another provider");
  });

  it("treats only a captured snapshot as the same sandbox", () => {
    expect(resumedSameVercelSandbox({ sandboxId: "a", snapshotId: "s", snapshotSandboxId: "a" })).toBe(true);
    expect(resumedSameVercelSandbox({ sandboxId: "b", snapshotId: "s", snapshotSandboxId: "a" })).toBe(false);
    expect(resumedSameVercelSandbox({ sandboxId: "a" })).toBe(false);
  });
});
