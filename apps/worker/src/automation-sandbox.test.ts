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
    expect(input.run).toHaveBeenCalledWith(session, expect.any(Function));
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
});
