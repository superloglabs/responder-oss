import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processAutomationRun } from "./automation-run.js";

const runId = "21212121-2121-4121-8121-212121212121";
const organizationId = "15151515-1515-4515-8515-151515151515";

function claimedRun() {
  return {
    automationId: "31313131-3131-4131-8131-313131313131",
    automationVersionId: "41414141-4141-4141-8141-414141414141",
    cancelRequestedAt: null,
    harness: "codex" as const,
    leaseId: "71717171-7171-4171-8171-717171717170",
    maxModelRequests: 8,
    maxOutputTokensPerRequest: 4_096,
    maxRuntimeSeconds: 600,
    model: "gpt-5.4",
    modelCredentialId: "51515151-5151-4151-8151-515151515151",
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
  const session = { state: { environment: {} } } as unknown as DaytonaSandboxSession;
  return {
    appendEvent: vi.fn().mockResolvedValue(undefined),
    cancellationRequested: vi.fn().mockResolvedValue(false),
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
    getWorkspaceSecrets: vi.fn().mockResolvedValue([]),
    heartbeatRun: vi.fn().mockResolvedValue(true),
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
    setStatus: vi.fn().mockResolvedValue(true),
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

    expect(deps.createGrant).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "customer-provider-secret",
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
    deps.getCredential.mockResolvedValue({ apiKey: "subscription-context-only", provider: "openai", subscription: { credentialId: claimedRun().modelCredentialId, authJson } });
    deps.acquireSubscription.mockResolvedValue(authJson);
    deps.runCodex.mockImplementation(async (_session, input) => {
      await input.model.subscription!.persist(authJson);
      return { eventStream: "" };
    });
    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);
    expect(deps.createGrant).toHaveBeenCalledWith(expect.objectContaining({ contextOnly: true, apiKey: "subscription-context-only" }));
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
    deps.getCredential.mockResolvedValue({ apiKey: "subscription-context-only", provider: "openai", subscription: { credentialId: claimedRun().modelCredentialId, authJson } });
    deps.acquireSubscription.mockResolvedValue(authJson);
    deps.runInSandbox.mockRejectedValue(new Error("cleanup failed"));
    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);
    expect(deps.releaseSubscription).not.toHaveBeenCalled();
  });
});
