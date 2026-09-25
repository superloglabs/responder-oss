import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationHarnessError } from "./automation-harness.js";
import { processAutomationRun } from "./automation-run.js";

const runId = "21212121-2121-4121-8121-212121212121";
const organizationId = "15151515-1515-4515-8515-151515151515";

function claimedRun() {
  return {
    automationId: "31313131-3131-4131-8131-313131313131",
    automationVersionId: "41414141-4141-4141-8141-414141414141",
    cancelRequestedAt: null,
    harness: "codex" as const,
    inferenceSource: "byok" as "byok" | "byos" | "responder",
    leaseId: "71717171-7171-4171-8171-717171717170",
    maxModelRequests: 8,
    maxOutputTokensPerRequest: 4_096,
    maxRuntimeSeconds: 600,
    model: "gpt-5.4",
    modelCredentialId: "51515151-5151-4151-8151-515151515151" as string | null,
    modelProvider: "openai" as const,
    organizationId,
    prompt: "Fix the failing test.",
    runId,
    toolPolicy: "full" as const,
    trigger: {
      channelIds: ["C123"],
      eventMode: "mentions" as const,
      integrationAccountId: "61616161-6161-4161-8161-616161616161",
      kind: "slack" as const,
    },
    triggerInput: {
      body: "The deployment failed",
      externalEventId: "event-1",
      provider: "slack",
      title: "Deployment failed",
    },
  };
}

function dependencies() {
  const session = {
    materializeEntry: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(new Error("not found")),
    state: { environment: {} },
  } as unknown as DaytonaSandboxSession;
  return {
    appendEvent: vi.fn().mockResolvedValue(undefined),
    cancellationRequested: vi.fn().mockResolvedValue(false),
    checkAllowance: vi.fn().mockResolvedValue({ allowed: true, nextResetAt: null }),
    checkoutRepositories: vi.fn().mockResolvedValue([{
      branch: "main",
      path: "/home/daytona/workspace/repositories/acme/app",
      repository: "acme/app",
      sha: "a".repeat(40),
      workspaceBaseSha: "a".repeat(40),
    }]),
    claimRun: vi.fn().mockResolvedValue(claimedRun()),
    createGrant: vi.fn().mockResolvedValue({
      expiresAt: new Date("2026-09-22T19:10:00.000Z"),
      id: "71717171-7171-4171-8171-717171717171",
      token: "opaque-run-token",
    }),
    executeActions: vi.fn().mockResolvedValue([{
      externalReference: "https://github.com/acme/app/pull/1",
      kind: "open_github_pull_request",
    }]),
    acquireSubscription: vi.fn(),
    persistSubscription: vi.fn().mockResolvedValue(undefined),
    releaseSubscription: vi.fn().mockResolvedValue(undefined),
    getCredential: vi.fn().mockResolvedValue({
      apiKey: "customer-provider-secret",
      provider: "openai",
    }),
    getConnections: vi.fn().mockResolvedValue([]),
    getConversation: vi.fn().mockResolvedValue([]),
    getWorkspaceSecrets: vi.fn().mockResolvedValue([]),
    heartbeatRun: vi.fn().mockResolvedValue(true),
    loadRepositories: vi.fn().mockResolvedValue([{
      branch: "main",
      path: "/home/daytona/workspace/repositories/acme/app",
      repository: "acme/app",
      sha: "b".repeat(40),
      workspaceBaseSha: "a".repeat(40),
    }]),
    now: () => new Date("2026-09-22T19:00:00.000Z"),
    reportException: vi.fn().mockResolvedValue(undefined),
    revokeGrant: vi.fn().mockResolvedValue(undefined),
    runClaude: vi.fn(),
    runCodex: vi.fn().mockResolvedValue({ eventStream: "completed" }),
    runInSandbox: vi.fn(async (input) => {
      try { return await input.run(session, async (operation: () => Promise<unknown>) => operation()); }
      finally { input.onCleanupConfirmed?.(); }
    }),
    runOpenCode: vi.fn(),
    saveSandbox: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(true),
    updateEvent: vi.fn().mockResolvedValue(undefined),
  };
}

describe("automation run processor", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("runs with only an opaque broker token in the fresh sandbox", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();

    await expect(processAutomationRun("job-1", {
      kind: "automation_run",
      queuedAt: "2026-09-22T19:00:00.000Z",
      runId,
    }, process.env, deps)).resolves.toEqual({ runId });

    // Organization-funded runs do not use the monthly allowance.
    expect(deps.checkAllowance).not.toHaveBeenCalled();
    expect(deps.createGrant).toHaveBeenCalledWith(expect.objectContaining({
      credential: {
        apiKey: "customer-provider-secret",
        inferenceSource: "byok",
      },
      organizationId,
      provider: "openai",
      runId,
    }));
    const sandboxInput = deps.runInSandbox.mock.calls[0]![0];
    expect(sandboxInput.brokerToken).toBe("opaque-run-token");
    expect(JSON.stringify(sandboxInput)).not.toContain("customer-provider-secret");
    expect(deps.runCodex).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      model: {
        brokerBaseUrl: "https://responder.example/api/automation-model-broker/v1",
        model: "gpt-5.4",
        provider: "openai",
      },
    }));
    // The first repository is the agent's working directory.
    expect(deps.runCodex.mock.calls[0]![1]).toMatchObject({
      workspacePath: "/home/daytona/workspace/repositories/acme/app",
    });
    expect(deps.runCodex.mock.calls[0]![1].prompt).toContain(
      "Your working directory is the acme/app repository, checked out at /home/daytona/workspace/repositories/acme/app.",
    );
    expect(deps.executeActions).toHaveBeenCalledOnce();
    expect(deps.setStatus).toHaveBeenCalledWith(expect.objectContaining({
      runId,
      status: "succeeded",
      usage: { actionCount: 1, harnessOutputBytes: 9 },
    }));
    expect(deps.revokeGrant).toHaveBeenCalledWith(expect.objectContaining({ runId }));
  });

  it("fails closed when the selected organization credential is unavailable", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.getCredential.mockResolvedValue(null);

    await processAutomationRun("job-1", {
      kind: "automation_run",
      queuedAt: "2026-09-22T19:00:00.000Z",
      runId,
    }, process.env, deps);

    expect(deps.createGrant).not.toHaveBeenCalled();
    expect(deps.runInSandbox).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith(expect.objectContaining({
      failureCategory: "execution_failed",
      runId,
      status: "failed",
    }));
  });
  it("runs a subscription natively with a context-only broker grant and releases its lease", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    const authJson = JSON.stringify({ tokens: { id_token: "id", access_token: "native-access", refresh_token: "native-refresh", account_id: "account" } });
    deps.claimRun.mockResolvedValue({ ...claimedRun(), inferenceSource: "byos" });
    deps.getCredential.mockResolvedValue({ apiKey: "subscription-context-only", provider: "openai", subscription: { credentialId: claimedRun().modelCredentialId, authJson } });
    deps.acquireSubscription.mockResolvedValue(authJson);
    deps.runCodex.mockImplementation(async (_session, input) => {
      await input.model.subscription!.persist(authJson);
      return { eventStream: "" };
    });
    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);
    expect(deps.createGrant).toHaveBeenCalledWith(expect.objectContaining({ credential: { inferenceSource: "byos" } }));
    expect(JSON.stringify(deps.createGrant.mock.calls)).not.toContain("native-refresh");
    expect(deps.runCodex).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: expect.objectContaining({ subscription: { authJson, persist: expect.any(Function) } }) }));
    expect(deps.persistSubscription).toHaveBeenCalledWith({ credentialId: claimedRun().modelCredentialId, organizationId, leaseId: claimedRun().leaseId, authJson, previousAccountId: "account" });
    expect(deps.releaseSubscription).toHaveBeenCalledWith(expect.objectContaining({ leaseId: claimedRun().leaseId, organizationId }));
  });

  it("retains the subscription lease when sandbox cleanup is unconfirmed", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    const authJson = JSON.stringify({ tokens: { id_token: "id", access_token: "access", refresh_token: "refresh", account_id: "account" } });
    deps.claimRun.mockResolvedValue({ ...claimedRun(), inferenceSource: "byos" });
    deps.getCredential.mockResolvedValue({ apiKey: "subscription-context-only", provider: "openai", subscription: { credentialId: claimedRun().modelCredentialId, authJson } });
    deps.acquireSubscription.mockResolvedValue(authJson);
    deps.runInSandbox.mockRejectedValue(new Error("cleanup failed"));
    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);
    expect(deps.releaseSubscription).not.toHaveBeenCalled();
  });

  it("uses Responder-funded inference without reading an organization key", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.claimRun.mockResolvedValue({
      ...claimedRun(),
      inferenceSource: "responder",
      modelCredentialId: null,
    });

    await processAutomationRun("job-1", {
      kind: "automation_run",
      queuedAt: "2026-09-22T19:00:00.000Z",
      runId,
    }, process.env, deps);

    expect(deps.checkAllowance).toHaveBeenCalledWith(organizationId);
    expect(deps.getCredential).not.toHaveBeenCalled();
    expect(deps.createGrant).toHaveBeenCalledWith(expect.objectContaining({
      credential: { inferenceSource: "responder" },
    }));
    expect(deps.setStatus).toHaveBeenCalledWith(expect.objectContaining({
      status: "succeeded",
    }));
  });

  it("stops before the sandbox when the included usage is used up", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.claimRun.mockResolvedValue({
      ...claimedRun(),
      inferenceSource: "responder",
      modelCredentialId: null,
    });
    deps.checkAllowance.mockResolvedValue({ allowed: false, nextResetAt: null });

    await processAutomationRun("job-1", {
      kind: "automation_run",
      queuedAt: "2026-09-22T19:00:00.000Z",
      runId,
    }, process.env, deps);

    expect(deps.createGrant).not.toHaveBeenCalled();
    expect(deps.runInSandbox).not.toHaveBeenCalled();
    expect(deps.reportException).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith(expect.objectContaining({
      failureCategory: "usage_limit_reached",
      failureMessage: expect.stringContaining("allowance"),
      status: "failed",
    }));
  });
  it("stores the transcript and summarizes the result", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.runCodex.mockResolvedValue({
      eventStream: [
        "Process exited with code 0",
        "Output:",
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Fixed the flaky test." } }),
      ].join("\n"),
    });

    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);

    expect(deps.appendEvent).toHaveBeenCalledWith({
      data: {
        items: [{ kind: "message", observedAt: Date.parse("2026-09-22T19:00:00.000Z"), text: "Fixed the flaky test." }],
        startedAt: Date.parse("2026-09-22T19:00:00.000Z"),
        truncated: false,
      },
      runId,
      type: "transcript",
    });
    expect(deps.setStatus).toHaveBeenCalledWith(expect.objectContaining({
      resultSummary: "PR #1 opened",
      status: "succeeded",
    }));
  });

  it("gives a follow-up turn the earlier conversation", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.getConversation.mockResolvedValue([
      { data: { items: [{ kind: "message", text: "The deploy config is wrong." }], truncated: false }, type: "transcript" },
      { data: { authorId: "user-1", authorName: "Ash", text: "Please add a regression test." }, type: "user_message" },
    ]);

    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);

    expect(deps.getConversation).toHaveBeenCalledWith(runId);
    const prompt = deps.runCodex.mock.calls[0]![1].prompt as string;
    expect(prompt).toContain("This run continues an earlier conversation.");
    expect(prompt).toContain("You:\nThe deploy config is wrong.");
    expect(prompt.trimEnd()).toMatch(/Workspace member Ash:\nPlease add a regression test\.$/u);
  });

  it("does not add a conversation to a first turn", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.getConversation.mockResolvedValue([
      { data: { authorId: "user-1", authorName: "Ash", text: "Try the checkout flow." }, type: "user_message" },
    ]);

    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);

    expect(deps.runCodex.mock.calls[0]![1].prompt).not.toContain("earlier conversation");
  });

  it("keeps the transcript of a failed harness", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.runCodex.mockRejectedValue(new AutomationHarnessError(
      "Codex automation harness failed",
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "pnpm test", exit_code: 1, status: "failed" } }),
    ));

    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);

    const types = deps.appendEvent.mock.calls.map(([event]) => event.type);
    expect(types.slice(-2)).toEqual(["transcript", "run_failed"]);
    expect(deps.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ items: [expect.objectContaining({ action: "run", kind: "tool", status: "failed", target: "pnpm test" })] }),
      type: "transcript",
    }));
    expect(deps.executeActions).not.toHaveBeenCalled();
  });
  it("resumes the paused sandbox of an earlier turn and pauses it again", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    const sessionState = { sandboxId: "sandbox-1" };
    deps.claimRun.mockResolvedValue({ ...claimedRun(), sandboxSessionState: sessionState });
    deps.getConversation.mockResolvedValue([
      { data: { items: [{ kind: "message", text: "Found it." }], truncated: false }, type: "transcript" },
      { data: { authorId: "user-1", authorName: "Ash", text: "Now add a test." }, type: "user_message" },
    ]);
    const order: string[] = [];
    deps.saveSandbox.mockImplementation(async () => { order.push("save"); });
    deps.setStatus.mockImplementation(async () => { order.push("status"); return true; });
    deps.runInSandbox.mockImplementation(async (input) => {
      const session = { materializeEntry: vi.fn(), readFile: vi.fn().mockRejectedValue(new Error("not found")), state: { environment: {} } } as unknown as DaytonaSandboxSession;
      const value = await input.run(session, async (operation: () => Promise<unknown>) => operation(), undefined, true);
      input.onPaused?.({ id: "sandbox-1", sessionState });
      return value;
    });

    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);

    expect(deps.runInSandbox.mock.calls[0]![0]).toMatchObject({ keepPaused: true, resumeState: sessionState });
    expect(deps.loadRepositories).toHaveBeenCalledOnce();
    expect(deps.checkoutRepositories).not.toHaveBeenCalled();
    expect(deps.runCodex.mock.calls[0]![1].prompt).toContain("Earlier turns ran in this sandbox");
    expect(deps.saveSandbox).toHaveBeenCalledWith({ leaseId: claimedRun().leaseId, runId, sandbox: { id: "sandbox-1", sessionState } });
    expect(order).toEqual(["save", "status"]);
  });

  it("deletes the sandbox of a subscription run", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    const authJson = JSON.stringify({ tokens: { id_token: "id", access_token: "access", refresh_token: "refresh", account_id: "account" } });
    deps.claimRun.mockResolvedValue({ ...claimedRun(), inferenceSource: "byos", sandboxSessionState: { sandboxId: "sandbox-1" } });
    deps.getCredential.mockResolvedValue({ apiKey: "subscription-context-only", provider: "openai", subscription: { credentialId: claimedRun().modelCredentialId, authJson } });
    deps.acquireSubscription.mockResolvedValue(authJson);

    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);

    const sandboxInput = deps.runInSandbox.mock.calls[0]![0];
    expect(sandboxInput.keepPaused).toBe(false);
    expect(sandboxInput.resumeState).toBeUndefined();
    expect(deps.saveSandbox).toHaveBeenCalledWith(expect.objectContaining({ sandbox: null }));
  });
});
