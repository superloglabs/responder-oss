import type {
  DaytonaSandboxClient,
  DaytonaSandboxSession,
} from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import { runInFreshAutomationSandbox } from "./automation-sandbox.js";

function harness() {
  const session = {
    state: { environment: {}, sandboxId: "sandbox-1" },
  } as unknown as DaytonaSandboxSession;
  const client = { create: vi.fn() } as unknown as DaytonaSandboxClient;
  const dependencies = {
    close: vi.fn().mockResolvedValue(undefined),
    closePending: vi.fn().mockResolvedValue(undefined),
    configure: vi.fn().mockResolvedValue(undefined),
    createClient: vi.fn(() => client),
    createSession: vi.fn().mockResolvedValue(session),
    prepare: vi.fn().mockResolvedValue(undefined),
  };
  return { client, dependencies, session };
}

const input = {
  brokerToken: "short-lived-run-token",
  config: { daytonaApiKey: "daytona-test" },
  organizationId: "organization-1",
  run: vi.fn(
    async (
      session: DaytonaSandboxSession,
      withModelBroker: <Result>(
        operation: () => Promise<Result>,
      ) => Promise<Result>,
    ) =>
      withModelBroker(async () =>
        session.state.environment.RESPONDER_MODEL_BROKER_TOKEN
          ? "completed"
          : "missing token",
      ),
  ),
  runId: "run-1",
};

describe("fresh automation sandbox", () => {
  it("creates one run-scoped sandbox and always deletes it", async () => {
    const { client, dependencies, session } = harness();

    await expect(
      runInFreshAutomationSandbox(input, dependencies),
    ).resolves.toBe("completed");

    expect(dependencies.createClient).toHaveBeenCalledWith({
      apiKey: "daytona-test",
      apiUrl: undefined,
      name: "responder-automation-run-1",
      pauseOnExit: false,
      sandboxSnapshotName: undefined,
      target: undefined,
    });
    expect(dependencies.createSession).toHaveBeenCalledWith(
      client,
      input.config,
      "responder-automation-run-1",
    );
    expect(input.run).toHaveBeenCalledWith(
      session,
      expect.any(Function),
      undefined,
      false,
    );
    expect(
      session.state.environment.RESPONDER_MODEL_BROKER_TOKEN,
    ).toBeUndefined();
    expect(dependencies.close).toHaveBeenCalledWith(
      session,
      input.config,
      { jobId: "run-1", organizationId: "organization-1" },
    );
  });

  it("deletes the sandbox when the harness fails", async () => {
    const { dependencies, session } = harness();
    const runError = new Error("harness failed");

    await expect(
      runInFreshAutomationSandbox(
        {
          ...input,
          run: vi.fn((_session, withModelBroker) =>
            withModelBroker(async () => {
              throw runError;
            }),
          ),
        },
        dependencies,
      ),
    ).rejects.toBe(runError);

    expect(dependencies.close).toHaveBeenCalledWith(
      session,
      input.config,
      { jobId: "run-1", organizationId: "organization-1" },
    );
    expect(
      session.state.environment.RESPONDER_MODEL_BROKER_TOKEN,
    ).toBeUndefined();
  });

  it("closes the sandbox when the run is aborted", async () => {
    const { dependencies, session } = harness();
    const controller = new AbortController();
    const timeout = new Error("runtime limit reached");
    const run = runInFreshAutomationSandbox(
      {
        ...input,
        run: vi.fn(() => new Promise(() => undefined)),
        signal: controller.signal,
      },
      dependencies,
    );

    controller.abort(timeout);

    await expect(run).rejects.toBe(timeout);
    expect(dependencies.close).toHaveBeenCalledWith(
      session,
      input.config,
      { jobId: "run-1", organizationId: "organization-1" },
    );
  });

  it("cancels setup and deletes a sandbox that has not returned a session", async () => {
    const { dependencies } = harness();
    const controller = new AbortController();
    const timeout = new Error("runtime limit reached during setup");
    dependencies.createSession.mockImplementation(
      () => new Promise(() => undefined),
    );
    const run = runInFreshAutomationSandbox(
      { ...input, signal: controller.signal },
      dependencies,
    );

    controller.abort(timeout);

    await expect(run).rejects.toBe(timeout);
    expect(dependencies.closePending).toHaveBeenCalledWith(
      "responder-automation-run-1",
      input.config,
    );
    expect(dependencies.configure).not.toHaveBeenCalled();
  });

  it("preserves the setup failure when pending sandbox cleanup also fails", async () => {
    const { dependencies } = harness();
    const setupError = new Error("sandbox creation failed");
    dependencies.createSession.mockRejectedValue(setupError);
    dependencies.closePending.mockRejectedValue(
      new Error("pending sandbox cleanup failed"),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runInFreshAutomationSandbox(input, dependencies),
    ).rejects.toBe(setupError);

    expect(dependencies.closePending).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("automation_pending_sandbox_cleanup_failed"),
    );
    consoleError.mockRestore();
  });

  it("uses a prepared snapshot without mutating its toolchain", async () => {
    const { dependencies } = harness();

    await runInFreshAutomationSandbox(
      {
        ...input,
        config: {
          daytonaApiKey: "daytona-test",
          sandboxSnapshotName: "automation-runtime",
        },
      },
      dependencies,
    );

    expect(dependencies.prepare).not.toHaveBeenCalled();
  });

  it("fails before creating a sandbox without a scoped broker token", async () => {
    const { dependencies } = harness();

    await expect(
      runInFreshAutomationSandbox(
        { ...input, brokerToken: "" },
        dependencies,
      ),
    ).rejects.toThrow("short-lived model broker token is required");
    expect(dependencies.createClient).not.toHaveBeenCalled();
  });

  it("rejects run IDs that could escape the sandbox namespace", async () => {
    const { dependencies } = harness();

    await expect(
      runInFreshAutomationSandbox(
        { ...input, runId: "../another-tenant" },
        dependencies,
      ),
    ).rejects.toThrow("cannot be used as a sandbox name");
    expect(dependencies.createClient).not.toHaveBeenCalled();
  });

  it("rejects generated sandbox names over the provider limit", async () => {
    const { dependencies } = harness();

    await expect(
      runInFreshAutomationSandbox(
        { ...input, runId: "a".repeat(44) },
        dependencies,
      ),
    ).rejects.toThrow("cannot be used as a sandbox name");
    expect(dependencies.createClient).not.toHaveBeenCalled();
  });

  it("serializes overlapping model broker operations and clears the token", async () => {
    const { dependencies, session } = harness();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;

    await runInFreshAutomationSandbox(
      {
        ...input,
        run: async (activeSession, withModelBroker) => {
          const first = withModelBroker(async () => {
            events.push("first:start");
            expect(
              activeSession.state.environment.RESPONDER_MODEL_BROKER_TOKEN,
            ).toBe("short-lived-run-token");
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
            events.push("first:end");
          });
          const second = withModelBroker(async () => {
            events.push("second:start");
            expect(
              activeSession.state.environment.RESPONDER_MODEL_BROKER_TOKEN,
            ).toBe("short-lived-run-token");
          });

          await vi.waitFor(() => {
            expect(events).toEqual(["first:start"]);
          });
          releaseFirst?.();
          await Promise.all([first, second]);
        },
      },
      dependencies,
    );

    expect(events).toEqual(["first:start", "first:end", "second:start"]);
    expect(
      session.state.environment.RESPONDER_MODEL_BROKER_TOKEN,
    ).toBeUndefined();
  });

  it("drains queued model operations before closing the sandbox", async () => {
    const { dependencies } = harness();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    dependencies.close.mockImplementation(async () => {
      events.push("close");
    });

    const run = runInFreshAutomationSandbox(
      {
        ...input,
        run: async (_session, withModelBroker) => {
          void withModelBroker(async () => {
            events.push("first:start");
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
            events.push("first:end");
          });
          void withModelBroker(async () => {
            events.push("second");
          });
          return "completed";
        },
      },
      dependencies,
    );

    await vi.waitFor(() => {
      expect(events).toEqual(["first:start"]);
    });
    releaseFirst?.();
    await expect(run).resolves.toBe("completed");
    expect(events).toEqual(["first:start", "first:end", "second", "close"]);
  });

  it("fails the run when a detached queued model operation fails", async () => {
    const { dependencies, session } = harness();
    const queueError = new Error("queued model call failed");

    await expect(
      runInFreshAutomationSandbox(
        {
          ...input,
          run: async (_session, withModelBroker) => {
            void withModelBroker(async () => {
              throw queueError;
            });
            return "completed too early";
          },
        },
        dependencies,
      ),
    ).rejects.toBe(queueError);
    expect(dependencies.close).toHaveBeenCalledWith(
      session,
      input.config,
      { jobId: "run-1", organizationId: "organization-1" },
    );
  });

  it("closes the sandbox when a detached model operation never settles", async () => {
    vi.useFakeTimers();
    const { dependencies, session } = harness();

    try {
      const run = runInFreshAutomationSandbox(
        {
          ...input,
          run: async (_session, withModelBroker) => {
            void withModelBroker(() => new Promise(() => undefined));
            return "completed too early";
          },
        },
        dependencies,
      );

      const rejection = expect(run).rejects.toThrow(
        "Model broker drain timed out",
      );
      await vi.runAllTimersAsync();
      await rejection;
      expect(dependencies.close).toHaveBeenCalledWith(
        session,
        input.config,
        { jobId: "run-1", organizationId: "organization-1" },
      );
      expect(
        session.state.environment.RESPONDER_MODEL_BROKER_TOKEN,
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
  it("pauses the sandbox and reports its state without the API key", async () => {
    const { client, dependencies, session } = harness();
    Object.assign(session, { close: vi.fn().mockResolvedValue(undefined) });
    Object.assign(client, {
      serializeSessionState: vi.fn().mockResolvedValue({
        apiKey: "daytona-test",
        environment: { RESPONDER_MODEL_BROKER_TOKEN: "leftover" },
        sandboxId: "sandbox-1",
      }),
    });
    const onPaused = vi.fn();

    await expect(runInFreshAutomationSandbox({ ...input, keepPaused: true, onPaused }, dependencies)).resolves.toBe("completed");

    expect(dependencies.createClient).toHaveBeenCalledWith(expect.objectContaining({ pauseOnExit: true }));
    expect(dependencies.configure).toHaveBeenCalledWith(session, input.config, [], 1_440);
    expect(session.close).toHaveBeenCalledOnce();
    expect(dependencies.close).not.toHaveBeenCalled();
    expect(onPaused).toHaveBeenCalledWith({ id: "sandbox-1", sessionState: { environment: {}, sandboxId: "sandbox-1" } });
  });

  it("resumes a set-up sandbox without setting it up again", async () => {
    const { client, dependencies, session } = harness();
    Object.assign(session, { close: vi.fn(), pathExists: vi.fn().mockResolvedValue(true) });
    Object.assign(client, {
      deserializeSessionState: vi.fn(async (state: unknown) => state),
      resume: vi.fn().mockResolvedValue(session),
      serializeSessionState: vi.fn().mockResolvedValue({ sandboxId: "sandbox-1" }),
    });

    await runInFreshAutomationSandbox({ ...input, keepPaused: true, resumeState: { sandboxId: "sandbox-1" } }, dependencies);

    expect(client.resume).toHaveBeenCalledWith({ sandboxId: "sandbox-1" });
    expect(dependencies.createSession).not.toHaveBeenCalled();
    expect(dependencies.configure).not.toHaveBeenCalled();
    expect(dependencies.prepare).not.toHaveBeenCalled();
    expect(input.run).toHaveBeenLastCalledWith(session, expect.any(Function), undefined, true);
  });

  it("starts a fresh sandbox when the paused one cannot be resumed", async () => {
    const { client, dependencies, session } = harness();
    Object.assign(session, { close: vi.fn() });
    Object.assign(client, {
      deserializeSessionState: vi.fn(async (state: unknown) => state),
      resume: vi.fn().mockRejectedValue(new Error("gone")),
      serializeSessionState: vi.fn().mockResolvedValue({ sandboxId: "sandbox-2" }),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runInFreshAutomationSandbox({ ...input, keepPaused: true, resumeState: { sandboxId: "sandbox-1" } }, dependencies);

    expect(dependencies.createSession).toHaveBeenCalledOnce();
    expect(dependencies.configure).toHaveBeenCalledOnce();
    expect(input.run).toHaveBeenLastCalledWith(session, expect.any(Function), undefined, false);
  });

  it("deletes the sandbox when it cannot be paused", async () => {
    const { client, dependencies, session } = harness();
    Object.assign(session, { close: vi.fn().mockRejectedValue(new Error("stop failed")) });
    Object.assign(client, { serializeSessionState: vi.fn().mockResolvedValue({ sandboxId: "sandbox-1" }) });
    const onPaused = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runInFreshAutomationSandbox({ ...input, keepPaused: true, onPaused }, dependencies);

    expect(onPaused).not.toHaveBeenCalled();
    expect(dependencies.close).toHaveBeenCalledOnce();
  });
});
