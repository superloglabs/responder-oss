import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { createAutomationToolHandler } from "./automation-actions.js";
import { AutomationHarnessError } from "./automation-harness.js";
import { processAutomationRun, type AutomationRunDependencies } from "./automation-run.js";
import { ModelCatalogError } from "@responder/core/automations/model-catalog";
import type { runCodexAutomation } from "./codex-automation-harness.js";

vi.mock("@responder/core/credentials/encryption", () => ({
  decryptCredentials: vi.fn(() => ({ accessToken: "xoxb-token" })),
}));

const runId = "21212121-2121-4121-8121-212121212121";
const credentialId = "51515151-5151-4151-8151-515151515151";
const organizationId = "15151515-1515-4515-8515-151515151515";

function claimedRun() {
  return {
    automationId: "31313131-3131-4131-8131-313131313131",
    automationName: "Weekly digest",
    automationVersionId: "41414141-4141-4141-8141-414141414141",
    cancelRequestedAt: null,
    harness: "codex" as const,
    leaseId: "71717171-7171-4171-8171-717171717170",
    maxModelRequests: 8,
    maxOutputTokensPerRequest: 4_096,
    maxRuntimeSeconds: 600,
    model: "gpt-5.4",
    modelProvider: "openai" as const,
    notifications: [] as Array<{ channelId: string; integrationAccountId: string; kind: "slack" }>,
    organizationId,
    prompt: "Fix the failing test.",
    runId,
    toolPolicy: "full" as const,
    triggers: [{
      channelIds: ["C123"],
      eventMode: "mentions" as const,
      integrationAccountId: "61616161-6161-4161-8161-616161616161",
      kind: "slack" as const,
    }],
    triggerInput: {
      body: "The deployment failed",
      externalEventId: "event-1",
      provider: "slack",
      title: "Deployment failed",
    },
  };
}

type ToolHandlerInput = Parameters<typeof createAutomationToolHandler>[0];

const pullRequest = {
  externalReference: "https://github.com/acme/app/pull/1",
  kind: "open_github_pull_request",
  repository: "acme/app",
  title: "Fix the failing test",
};

function dependencies() {
  const toolHandlers: ToolHandlerInput[] = [];
  // Plays an agent that opens a pull request with the tool mid-run.
  const openPullRequest = async () => {
    await toolHandlers.at(-1)!.onAction(pullRequest);
  };
  const session = {
    materializeEntry: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(new Error("not found")),
    state: { environment: {} },
  } as unknown as DaytonaSandboxSession;
  return {
    appendEvent: vi.fn().mockResolvedValue(undefined),
    cancellationRequested: vi.fn().mockResolvedValue(false),
    checkAllowance: vi.fn().mockResolvedValue({ allowed: true, nextResetAt: null }),
    sandboxTimeIsBilled: vi.fn(() => false),
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
    createToolHandler: vi.fn((input: ToolHandlerInput) => {
      toolHandlers.push(input);
      return vi.fn();
    }),
    openPullRequest,
    session: session as DaytonaSandboxSession & { materializeEntry: ReturnType<typeof vi.fn> },
    getCredential: vi.fn().mockResolvedValue({
      apiKey: "customer-provider-secret",
      provider: "openai",
    }),
    listProviderModels: vi.fn<AutomationRunDependencies["listProviderModels"]>().mockResolvedValue([{ id: "gpt-5.4", name: "GPT-5.4" }]),
    selectCredential: vi.fn<AutomationRunDependencies["selectCredential"]>().mockResolvedValue(credentialId),
    getConnections: vi.fn().mockResolvedValue([]),
    getConversation: vi.fn().mockResolvedValue([]),
    getNotificationChannelNames: vi.fn().mockResolvedValue(new Map<string, string>()),
    getRunActor: vi.fn().mockResolvedValue("user-1"),
    hasCapability: vi.fn<AutomationRunDependencies["hasCapability"]>().mockResolvedValue(false),
    hasFinishedTurn: vi.fn(async () => false),
    getWorkspaceSecrets: vi.fn().mockResolvedValue([]),
    grantAllowanceExhausted: vi.fn().mockResolvedValue(false),
    hasNewMessages: vi.fn().mockResolvedValue(false),
    heartbeatRun: vi.fn().mockResolvedValue(true),
    loadRepositories: vi.fn().mockResolvedValue([{
      branch: "main",
      path: "/home/daytona/workspace/repositories/acme/app",
      repository: "acme/app",
      sha: "b".repeat(40),
      workspaceBaseSha: "a".repeat(40),
    }]),
    notify: vi.fn().mockResolvedValue(undefined),
    now: () => new Date("2026-09-22T19:00:00.000Z"),
    postedInSlackThread: vi.fn().mockResolvedValue(false),
    reopenRun: vi.fn().mockResolvedValue(true),
    reportException: vi.fn().mockResolvedValue(undefined),
    requeueRun: vi.fn().mockResolvedValue(undefined),
    revokeGrant: vi.fn().mockResolvedValue(undefined),
    runClaude: vi.fn(),
    runCodex: vi.fn<typeof runCodexAutomation>(async () => {
      await openPullRequest();
      return { eventStream: "completed" };
    }),
    runInSandbox: vi.fn(async (input) => {
      try { return await input.run(session, async (operation: () => Promise<unknown>) => operation()); }
      finally { input.onCleanupConfirmed?.(); }
    }),
    runOpenCode: vi.fn(),
    saveSandbox: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(true),
    subscriptionAuth: vi.fn<(owner: { credentialId: string; organizationId: string }, validUntil: Date) => Promise<string>>(),
    createSubscriptionSecret: vi.fn<AutomationRunDependencies["createSubscriptionSecret"]>().mockResolvedValue({ id: "secret-1", name: "responder_chatgpt_run", placeholder: "dtn_secret_run" }),
    deleteSubscriptionSecret: vi.fn<AutomationRunDependencies["deleteSubscriptionSecret"]>().mockResolvedValue(undefined),
    slackCard: {
      now: () => Date.parse("2026-09-22T19:00:00.000Z"),
      post: vi.fn().mockResolvedValue("1790000001.000200"),
      update: vi.fn().mockResolvedValue(undefined),
    },
    updateEvent: vi.fn().mockResolvedValue(undefined),
    workspaceTools: vi.fn<AutomationRunDependencies["workspaceTools"]>(() => []),
  };
}

describe("automation run processor", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("serves a trigger-only Slack connection when Slack started the run", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    const slackId = "61616161-6161-4161-8161-616161616161";
    const sentryId = "62626262-6262-4262-8262-626262626262";
    deps.getConnections.mockResolvedValue([
      { id: slackId, provider: "slack", role: "trigger" },
      { id: slackId, provider: "slack", role: "context" },
      { id: sentryId, provider: "sentry", role: "trigger" },
    ]);

    await processAutomationRun("job-1", {
      kind: "automation_run",
      queuedAt: "2026-09-22T19:00:00.000Z",
      runId,
    }, process.env, deps);

    expect(deps.runCodex.mock.calls[0]![1].contextServers).toEqual([{
      name: "slack_61616161616141618161616161616161",
      url: `https://responder.example/api/automation-context-broker/v1/${slackId}`,
    }]);
  });

  it("serves a Linear context connection through the broker", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    const linearId = "63636363-6363-4363-8363-636363636363";
    deps.getConnections.mockResolvedValue([{ id: linearId, provider: "linear", role: "context" }]);

    await processAutomationRun("job-1", {
      kind: "automation_run",
      queuedAt: "2026-09-22T19:00:00.000Z",
      runId,
    }, process.env, deps);

    expect(deps.runCodex.mock.calls[0]![1].contextServers).toEqual([{
      name: "linear_63636363636343638363636363636363",
      url: `https://responder.example/api/automation-context-broker/v1/${linearId}`,
    }]);
  });

  it("serves each Google Cloud context connection as one server per Google service", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    const gcpId = "63636363-6363-4363-8363-636363636363";
    deps.getConnections.mockResolvedValue([
      { id: gcpId, provider: "gcp", role: "context" },
    ]);

    await processAutomationRun("job-1", {
      kind: "automation_run",
      queuedAt: "2026-09-22T19:00:00.000Z",
      runId,
    }, process.env, deps);

    const broker = `https://responder.example/api/automation-context-broker/v1/${gcpId}`;
    expect(deps.runCodex.mock.calls[0]![1].contextServers).toEqual([
      { name: "gcp_63636363636343638363636363636363_assets", url: `${broker}/assets` },
      { name: "gcp_63636363636343638363636363636363_logging", url: `${broker}/logging` },
      { name: "gcp_63636363636343638363636363636363_monitoring", url: `${broker}/monitoring` },
    ]);
  });

  it("tells the agent which Google Cloud projects its context servers reach", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.getConnections.mockResolvedValue([
      {
        encryptedCredentials: "encrypted-gcp",
        externalAccountId: "superlog-494218",
        id: "64646464-6464-4464-8464-646464646464",
        metadata: { projectNumber: "297477702017" },
        provider: "gcp",
        role: "context",
      },
    ]);

    await processAutomationRun("job-1", {
      kind: "automation_run",
      queuedAt: "2026-09-22T19:00:00.000Z",
      runId,
    }, process.env, deps);

    const prompt = deps.runCodex.mock.calls[0]![1].prompt;
    expect(prompt).toContain("superlog-494218");
    expect(prompt).toContain("projects/superlog-494218");
    expect(prompt).toContain("297477702017");
  });

  it("gives runs the workspace tools in workspaces with simplified navigation", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    vi.stubEnv("RESPONDER_APP_URL", "https://app.responder.example");
    const deps = dependencies();
    const workspaceTool = {
      description: "Read this workspace.",
      execute: vi.fn(),
      name: "get_workspace",
      parameters: z.object({}),
      readOnly: true,
    };
    deps.hasCapability.mockImplementation(async (_organizationId, capability) =>
      capability === "simplified_navigation");
    deps.workspaceTools.mockReturnValue([workspaceTool]);

    await processAutomationRun("job-1", {
      kind: "automation_run",
      queuedAt: "2026-09-22T19:00:00.000Z",
      runId,
    }, process.env, deps);

    expect(deps.getRunActor).toHaveBeenCalledWith({
      automationVersionId: claimedRun().automationVersionId,
      organizationId,
    });
    expect(deps.workspaceTools).toHaveBeenCalledWith({
      actorUserId: "user-1",
      automationsEnabled: true,
      integrationsUrl: "https://app.responder.example/settings",
      organizationId,
      source: "automation_run",
    });
    expect(deps.createToolHandler.mock.calls[0]![0].workspaceTools).toEqual([workspaceTool]);
    const server = deps.session.materializeEntry.mock.calls
      .map(([call]) => call as { entry: { content: string }; path: string })
      .find((call) => call.path.endsWith("/tools/server.mjs"));
    expect(server?.entry.content).toContain("\"name\":\"get_workspace\"");
    const prompt = deps.runCodex.mock.calls[0]![1].prompt;
    expect(prompt).toContain("Call get_workspace before changing anything");
    expect(prompt).toContain("https://app.responder.example/settings");
  });

  it("leaves out the workspace tools without simplified navigation", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();

    await processAutomationRun("job-1", {
      kind: "automation_run",
      queuedAt: "2026-09-22T19:00:00.000Z",
      runId,
    }, process.env, deps);

    expect(deps.workspaceTools).not.toHaveBeenCalled();
    expect(deps.createToolHandler.mock.calls[0]![0].workspaceTools).toEqual([]);
    expect(deps.runCodex.mock.calls[0]![1].prompt).not.toContain("get_workspace");
  });

  describe("Slack plan card", () => {
    const slackStartedRun = (mentioned = true) => ({
      ...claimedRun(),
      triggerInput: {
        ...claimedRun().triggerInput,
        attributes: {
          channelId: "C123",
          mentioned,
          teamId: "T123",
          threadTimestamp: "1790000000.000100",
          timestamp: "1790000000.000200",
        },
      },
    });
    const slackConnection = {
      encryptedCredentials: "encrypted-slack-token",
      externalAccountId: "T123",
      id: "61616161-6161-4161-8161-616161616161",
      metadata: {},
      provider: "slack",
      role: "trigger" as const,
    };
    const job = {
      kind: "automation_run" as const,
      queuedAt: "2026-09-22T19:00:00.000Z",
      runId,
    };

    it("posts a card in the triggering thread before the sandbox starts and completes it", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      const deps = dependencies();
      deps.claimRun.mockResolvedValue(slackStartedRun());
      deps.getConnections.mockResolvedValue([slackConnection]);

      await processAutomationRun("job-1", job, process.env, deps);

      expect(deps.slackCard.post).toHaveBeenCalledWith(expect.objectContaining({
        accessToken: "xoxb-token",
        channelId: "C123",
        text: "Automation running",
        threadTimestamp: "1790000000.000100",
      }));
      expect(deps.slackCard.post.mock.invocationCallOrder[0]).toBeLessThan(
        deps.runInSandbox.mock.invocationCallOrder[0]!,
      );
      expect(deps.slackCard.update).toHaveBeenLastCalledWith(expect.objectContaining({
        text: "Automation complete",
        timestamp: "1790000001.000200",
      }));
    });

    it("posts nothing in the thread when the agent does not post in a run nobody asked for", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      const deps = dependencies();
      deps.claimRun.mockResolvedValue(slackStartedRun(false));
      deps.getConnections.mockResolvedValue([slackConnection]);

      await processAutomationRun("job-1", job, process.env, deps);

      const prompt = deps.runCodex.mock.calls[0]![1].prompt;
      expect(prompt).toContain("name who posted the message (authorName, authorId, and authorType");
      expect(prompt).toContain("when the automation's instructions say to skip this message, finish without posting or reacting");
      expect(deps.postedInSlackThread).toHaveBeenCalledWith({
        channelId: "C123",
        runId,
        threadTimestamp: "1790000000.000100",
      });
      expect(deps.slackCard.post).not.toHaveBeenCalled();
    });

    it("posts the card after the agent posts in the thread of a run nobody asked for", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      const deps = dependencies();
      deps.claimRun.mockResolvedValue(slackStartedRun(false));
      deps.getConnections.mockResolvedValue([slackConnection]);
      deps.postedInSlackThread.mockResolvedValue(true);

      await processAutomationRun("job-1", job, process.env, deps);

      expect(deps.slackCard.post).toHaveBeenCalledOnce();
      expect(deps.slackCard.post).toHaveBeenCalledWith(expect.objectContaining({
        text: "Automation complete",
        threadTimestamp: "1790000000.000100",
      }));
      expect(deps.slackCard.post.mock.invocationCallOrder[0]).toBeGreaterThan(
        deps.runInSandbox.mock.invocationCallOrder[0]!,
      );
    });

    it("marks the card stopped when the run fails", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      const deps = dependencies();
      deps.claimRun.mockResolvedValue(slackStartedRun());
      deps.getConnections.mockResolvedValue([slackConnection]);
      deps.runCodex.mockRejectedValue(new AutomationHarnessError("Codex automation harness failed", ""));

      await processAutomationRun("job-1", job, process.env, deps);

      expect(deps.slackCard.update).toHaveBeenLastCalledWith(expect.objectContaining({
        text: expect.stringMatching(/^Automation stopped: /u),
      }));
    });

    it("answers a Slack reply in the thread with a new card", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      const deps = dependencies();
      deps.claimRun.mockResolvedValue(slackStartedRun());
      deps.getConnections.mockResolvedValue([slackConnection]);
      deps.getConversation.mockResolvedValue([
        { data: { items: [{ kind: "message", text: "The JSON literal is malformed." }], truncated: false }, id: 1, type: "transcript" },
        {
          data: { authorId: "U123", authorName: "Ada", externalEventId: "C123:1790000002.000100", source: "slack", text: "Can you open a PR?" },
          id: 2,
          type: "user_message",
        },
      ]);

      await processAutomationRun("job-1", job, process.env, deps);

      const prompt = deps.runCodex.mock.calls[0]![1].prompt;
      expect(prompt).toContain("Slack reply from Ada (<@U123>):\nCan you open a PR?");
      expect(prompt).toContain("Answer it in that thread");
      expect(deps.slackCard.post).toHaveBeenCalledWith(expect.objectContaining({
        threadTimestamp: "1790000000.000100",
      }));
    });

    it("answers a Slack reply saved before the previous turn's transcript", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      const deps = dependencies();
      deps.claimRun.mockResolvedValue(slackStartedRun());
      deps.getConnections.mockResolvedValue([slackConnection]);
      // The reply was stored while the previous turn was starting up.
      deps.getConversation.mockResolvedValue([
        {
          data: { authorId: "U123", authorName: "Ada", externalEventId: "C123:2.0", source: "slack", text: "Is staging affected too?" },
          id: 2,
          type: "user_message",
        },
        { data: { items: [{ kind: "message", text: "Found the cause." }], truncated: false }, id: 3, type: "transcript" },
      ]);

      await processAutomationRun("job-1", job, process.env, deps);

      expect(deps.runCodex.mock.calls[0]![1].prompt).toContain("Answer it in that thread");
      expect(deps.slackCard.post).toHaveBeenCalled();
    });

    it("leaves follow-up turns to the run page", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      const deps = dependencies();
      deps.hasFinishedTurn.mockResolvedValue(true);
      deps.claimRun.mockResolvedValue(slackStartedRun());
      deps.getConnections.mockResolvedValue([slackConnection]);
      deps.getConversation.mockResolvedValue([
        { data: { items: [], truncated: false }, id: 1, type: "transcript" },
      ]);

      await processAutomationRun("job-1", job, process.env, deps);

      expect(deps.slackCard.post).not.toHaveBeenCalled();
    });
  });

  it("records a cancel as cancelled when cleanup also fails", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    vi.useFakeTimers();
    try {
      const deps = dependencies();
      deps.cancellationRequested.mockResolvedValueOnce(false).mockResolvedValue(true);
      // The sandbox reports the abort together with a failed model operation.
      deps.runInSandbox.mockImplementation((input) => new Promise((_, reject) => {
        input.signal!.addEventListener("abort", () => reject(new AggregateError(
          [input.signal!.reason, new Error("model operation failed")],
          "Automation callback and queued model operation failed",
        )));
      }));

      const processing = processAutomationRun("job-1", {
        kind: "automation_run",
        queuedAt: "2026-09-22T19:00:00.000Z",
        runId,
      }, process.env, deps);
      await vi.advanceTimersByTimeAsync(5_000);
      await processing;

      expect(deps.setStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
      expect(deps.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "run_cancelled" }));
      expect(deps.reportException).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("notifications", () => {
    const notification = {
      channelId: "C999",
      integrationAccountId: "61616161-6161-4161-8161-616161616161",
      kind: "slack" as const,
    };
    const job = { kind: "automation_run" as const, queuedAt: "2026-09-22T19:00:00.000Z", runId };
    const scheduledRun = () => ({ ...claimedRun(), notifications: [notification] });

    it("posts the agent's final response when the first turn succeeds", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      const deps = dependencies();
      deps.claimRun.mockResolvedValue(scheduledRun());
      deps.runCodex.mockResolvedValue({
        eventStream: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Three issues still need fixes." } }),
      });

      await processAutomationRun("job-1", job, process.env, deps);

      expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({
        automationId: "31313131-3131-4131-8131-313131313131",
        automationName: "Weekly digest",
        notifications: [notification],
        organizationId,
        outcome: { message: "Three issues still need fixes.", status: "succeeded" },
        runId,
      }));
    });

    it("lets the agent post its own report and skips the fallback", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      vi.stubEnv("RESPONDER_APP_URL", "https://responder.example");
      const deps = dependencies();
      deps.claimRun.mockResolvedValue(scheduledRun());
      deps.getNotificationChannelNames.mockResolvedValue(new Map([[`${notification.integrationAccountId}:C999`, "ops"]]));
      deps.runCodex.mockImplementation(async () => {
        deps.createToolHandler.mock.calls.at(-1)![0].notifications!.onPosted(notification);
        return { eventStream: "completed" };
      });

      await processAutomationRun("job-1", job, process.env, deps);

      const prompt = deps.runCodex.mock.calls[0]![1].prompt;
      expect(prompt).toContain("This automation reports to Slack: #ops.");
      expect(prompt).toContain("post_notification");
      expect(deps.createToolHandler).toHaveBeenCalledWith(expect.objectContaining({
        notifications: expect.objectContaining({
          notifications: [notification],
          runUrl: expect.stringContaining(`/runs/${runId}`),
        }),
      }));
      expect(deps.notify).not.toHaveBeenCalled();
    });

    it("posts nothing when the agent skips the notification", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      const deps = dependencies();
      deps.claimRun.mockResolvedValue(scheduledRun());
      deps.runCodex.mockImplementation(async () => {
        const notifications = deps.createToolHandler.mock.calls.at(-1)![0].notifications!;
        await notifications.onSkipped("Duplicate of a known issue.");
        await notifications.onSkipped("Called again.");
        return { eventStream: "completed" };
      });

      await processAutomationRun("job-1", job, process.env, deps);

      expect(deps.runCodex.mock.calls[0]![1].prompt).toContain("skip_notification");
      expect(deps.notify).not.toHaveBeenCalled();
      const skipped = deps.appendEvent.mock.calls.filter(([event]) => event.type === "notification_skipped");
      expect(skipped).toEqual([[{ data: { reason: "Duplicate of a known issue." }, runId, type: "notification_skipped" }]]);
    });

    it("still reports a failed run the agent chose not to report", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      const deps = dependencies();
      deps.claimRun.mockResolvedValue(scheduledRun());
      deps.runCodex.mockImplementation(async () => {
        await deps.createToolHandler.mock.calls.at(-1)![0].notifications!.onSkipped("Nothing new.");
        throw new AutomationHarnessError("Codex automation harness failed", "");
      });

      await processAutomationRun("job-1", job, process.env, deps);

      expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({
        notifications: [notification],
        outcome: { message: "Codex automation harness failed", status: "failed" },
      }));
    });

    it("posts the final reply only to channels the agent did not reach", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      const second = { ...notification, channelId: "C888" };
      const deps = dependencies();
      deps.claimRun.mockResolvedValue({ ...scheduledRun(), notifications: [notification, second] });
      deps.runCodex.mockImplementation(async () => {
        deps.createToolHandler.mock.calls.at(-1)![0].notifications!.onPosted(notification);
        return { eventStream: "completed" };
      });

      await processAutomationRun("job-1", job, process.env, deps);

      expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({ notifications: [second] }));
    });

    it("offers the notification tool only on the first turn", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      const deps = dependencies();
      deps.hasFinishedTurn.mockResolvedValue(true);
      deps.claimRun.mockResolvedValue(scheduledRun());
      deps.getConversation.mockResolvedValue([
        { data: { items: [], truncated: false }, id: 1, type: "transcript" },
        { data: { authorId: "user-1", authorName: "Ash", text: "Shorten the summary." }, id: 2, type: "user_message" },
      ]);

      await processAutomationRun("job-1", job, process.env, deps);

      expect(deps.runCodex.mock.calls[0]![1].prompt).not.toContain("post_notification");
      expect(deps.createToolHandler.mock.calls[0]![0].notifications).toBeUndefined();
    });

    it("still reports a first turn retried after its worker stopped", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      const deps = dependencies();
      deps.claimRun.mockResolvedValue(scheduledRun());
      // The stopped worker stored part of a transcript but never finished.
      deps.getConversation.mockResolvedValue([
        { data: { items: [{ kind: "message", text: "Starting." }], truncated: false }, id: 1, type: "transcript" },
      ]);
      deps.hasFinishedTurn.mockResolvedValue(false);

      await processAutomationRun("job-1", job, process.env, deps);

      expect(deps.createToolHandler.mock.calls[0]![0].notifications).toBeDefined();
      expect(deps.notify).toHaveBeenCalled();
    });

    it("reports a failed run and records a channel that could not be reached", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      const deps = dependencies();
      deps.claimRun.mockResolvedValue(scheduledRun());
      deps.runCodex.mockRejectedValue(new AutomationHarnessError("Codex automation harness failed", ""));
      deps.notify.mockImplementation(async (input) => {
        await input.onError(notification, new Error("not_in_channel"));
      });

      await processAutomationRun("job-1", job, process.env, deps);

      expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({
        outcome: { message: "Codex automation harness failed", status: "failed" },
      }));
      expect(deps.appendEvent).toHaveBeenCalledWith({
        data: { channelId: "C999", kind: "slack", message: "not_in_channel" },
        runId,
        type: "notification_failed",
      });
    });

    it("reports a run that fails before its sandbox starts", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      const deps = dependencies();
      deps.claimRun.mockResolvedValue(scheduledRun());
      deps.selectCredential.mockResolvedValue(null);
      deps.checkAllowance.mockResolvedValue({ allowed: false, nextResetAt: null });

      await processAutomationRun("job-1", job, process.env, deps);

      expect(deps.runInSandbox).not.toHaveBeenCalled();
      expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({
        outcome: expect.objectContaining({ status: "failed" }),
      }));
    });

    it("does not notify for follow-up turns, cancelled runs, or automations without notifications", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      const followUp = dependencies();
      followUp.hasFinishedTurn.mockResolvedValue(true);
      followUp.claimRun.mockResolvedValue(scheduledRun());
      followUp.getConversation.mockResolvedValue([
        { data: { items: [], truncated: false }, id: 1, type: "transcript" },
        { data: { authorId: "user-1", authorName: "Ash", text: "Add a summary." }, id: 2, type: "user_message" },
      ]);
      await processAutomationRun("job-1", job, process.env, followUp);
      expect(followUp.notify).not.toHaveBeenCalled();

      const cancelled = dependencies();
      cancelled.claimRun.mockResolvedValue(scheduledRun());
      cancelled.cancellationRequested.mockResolvedValueOnce(false).mockResolvedValue(true);
      await processAutomationRun("job-1", job, process.env, cancelled);
      expect(cancelled.notify).not.toHaveBeenCalled();

      const none = dependencies();
      await processAutomationRun("job-1", job, process.env, none);
      expect(none.notify).not.toHaveBeenCalled();
    });
  });

  describe("replies that arrive during a turn", () => {
    const job = {
      kind: "automation_run" as const,
      queuedAt: "2026-09-22T19:00:00.000Z",
      runId,
    };

    it("starts the next turn for a reply stored after the prompt was read", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      const deps = dependencies();
      deps.getConversation.mockResolvedValue([
        { data: { items: [], truncated: false }, id: 7, type: "transcript" },
      ]);
      deps.hasNewMessages.mockResolvedValue(true);

      await processAutomationRun("job-1", job, process.env, deps);

      expect(deps.hasNewMessages).toHaveBeenCalledWith({ afterEventId: 7, runId });
      // Only while no other turn has claimed or reopened the run since.
      expect(deps.reopenRun).toHaveBeenCalledWith(runId, "71717171-7171-4171-8171-717171717170");
      expect(deps.requeueRun).toHaveBeenCalledWith(runId);
      // The run finished this turn before it was reopened.
      expect(deps.setStatus.mock.invocationCallOrder[0]).toBeLessThan(
        deps.reopenRun.mock.invocationCallOrder[0]!,
      );
    });

    it("leaves the turn to the control plane when it already reopened the run", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      const deps = dependencies();
      deps.hasNewMessages.mockResolvedValue(true);
      deps.reopenRun.mockResolvedValue(false);

      await processAutomationRun("job-1", job, process.env, deps);

      expect(deps.requeueRun).not.toHaveBeenCalled();
    });

    it("finishes normally without new replies", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      const deps = dependencies();

      await processAutomationRun("job-1", job, process.env, deps);

      expect(deps.hasNewMessages).toHaveBeenCalledWith({ afterEventId: 0, runId });
      expect(deps.reopenRun).not.toHaveBeenCalled();
      expect(deps.requeueRun).not.toHaveBeenCalled();
    });

    it("marks the run failed when the next turn cannot be queued", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      const deps = dependencies();
      deps.hasNewMessages.mockResolvedValue(true);
      deps.requeueRun.mockRejectedValue(new Error("queue down"));

      await processAutomationRun("job-1", job, process.env, deps);

      expect(deps.setStatus).toHaveBeenLastCalledWith(expect.objectContaining({
        failureCategory: "queue_unavailable",
        runId,
        status: "failed",
      }));
    });

    it("does not continue a cancelled run", async () => {
      vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
      vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
      const deps = dependencies();
      deps.hasNewMessages.mockResolvedValue(true);
      deps.cancellationRequested.mockResolvedValueOnce(false).mockResolvedValue(true);

      await processAutomationRun("job-1", job, process.env, deps);

      expect(deps.reopenRun).not.toHaveBeenCalled();
    });
  });

  it("does not serve a trigger-only Slack connection for other triggers", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.claimRun.mockResolvedValue({
      ...claimedRun(),
      triggerInput: { ...claimedRun().triggerInput, provider: "sentry" },
    });
    deps.getConnections.mockResolvedValue([
      { id: "61616161-6161-4161-8161-616161616161", provider: "slack", role: "trigger" },
    ]);

    await processAutomationRun("job-1", {
      kind: "automation_run",
      queuedAt: "2026-09-22T19:00:00.000Z",
      runId,
    }, process.env, deps);

    expect(deps.runCodex.mock.calls[0]![1].contextServers).toEqual([]);
  });

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
        maxOutputTokensPerRequest: 4_096,
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
    // The agent opens pull requests with a tool while it works.
    expect(deps.runCodex.mock.calls[0]![1].toolServer).toEqual({
      args: ["/home/daytona/workspace/.responder/tools/server.mjs"],
      command: "node",
      name: "superlog",
    });
    expect(deps.createToolHandler).toHaveBeenCalledWith(expect.objectContaining({
      automationVersionId: "41414141-4141-4141-8141-414141414141",
      checkedOutRepositories: [expect.objectContaining({ repository: "acme/app" })],
      runId,
    }));
    expect(deps.appendEvent).toHaveBeenCalledWith({
      data: pullRequest,
      runId,
      type: "action_succeeded",
    });
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
  it("runs a subscription natively while the access token stays in a Daytona secret", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    const idToken = `header.${Buffer.from(JSON.stringify({ email: "person@example.com" })).toString("base64url")}.native-id-signature`;
    const authJson = JSON.stringify({ tokens: { id_token: idToken, access_token: "native-access", refresh_token: "native-refresh", account_id: "account" } });
    deps.claimRun.mockResolvedValue(claimedRun());
    deps.getCredential.mockResolvedValue({ apiKey: "subscription-context-only", provider: "openai", subscription: { credentialId: credentialId, authJson } });
    deps.subscriptionAuth.mockResolvedValue(authJson);
    deps.runCodex.mockResolvedValue({ eventStream: "" });
    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);
    expect(deps.subscriptionAuth).toHaveBeenCalledWith(
      { credentialId: credentialId, organizationId },
      new Date(deps.now().getTime() + (claimedRun().maxRuntimeSeconds + 1_800) * 1_000),
    );
    expect(deps.createSubscriptionSecret).toHaveBeenCalledWith({ accessToken: "native-access", runId });
    expect(deps.createGrant).toHaveBeenCalledWith(expect.objectContaining({ credential: { inferenceSource: "byos" } }));
    expect(deps.runInSandbox).toHaveBeenCalledWith(expect.objectContaining({
      secrets: [{ daytonaSecretName: "responder_chatgpt_run", environmentVariable: "RESPONDER_CHATGPT_ACCESS_TOKEN" }],
    }));
    const sandboxAuth = JSON.parse(deps.runCodex.mock.calls[0]![1].model.subscription!.authJson);
    expect(sandboxAuth.tokens.access_token).toBe("dtn_secret_run");
    expect(sandboxAuth.tokens.refresh_token).toBe("responder-run-only");
    for (const secret of ["native-access", "native-refresh", "native-id-signature"]) {
      expect(JSON.stringify(deps.runCodex.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(deps.runInSandbox.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(deps.createGrant.mock.calls)).not.toContain(secret);
    }
    expect(deps.deleteSubscriptionSecret).toHaveBeenCalledWith("secret-1");
  });

  it("deletes the run's subscription secret when the run fails", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    const authJson = JSON.stringify({ tokens: { id_token: "id", access_token: "access", refresh_token: "refresh", account_id: "account" } });
    deps.claimRun.mockResolvedValue(claimedRun());
    deps.getCredential.mockResolvedValue({ apiKey: "subscription-context-only", provider: "openai", subscription: { credentialId, authJson } });
    deps.subscriptionAuth.mockResolvedValue(authJson);
    deps.runInSandbox.mockRejectedValue(new Error("sandbox failed"));
    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);
    expect(deps.setStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(deps.deleteSubscriptionSecret).toHaveBeenCalledWith("secret-1");
  });

  it("fails a subscription run before starting a sandbox when the login cannot cover it", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    const authJson = JSON.stringify({ tokens: { id_token: "id", access_token: "access", refresh_token: "refresh", account_id: "account" } });
    deps.claimRun.mockResolvedValue(claimedRun());
    deps.getCredential.mockResolvedValue({ apiKey: "subscription-context-only", provider: "openai", subscription: { credentialId: credentialId, authJson } });
    deps.subscriptionAuth.mockRejectedValue(new Error("ChatGPT did not renew the subscription login. Reconnect it in model settings."));
    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);
    expect(deps.runInSandbox).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("uses Responder-funded inference without reading an organization key", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.claimRun.mockResolvedValue(claimedRun());
    deps.selectCredential.mockResolvedValue(null);

    await processAutomationRun("job-1", {
      kind: "automation_run",
      queuedAt: "2026-09-22T19:00:00.000Z",
      runId,
    }, process.env, deps);

    expect(deps.selectCredential).toHaveBeenCalledWith({ harness: "codex", organizationId, provider: "openai" });
    expect(deps.checkAllowance).toHaveBeenCalledWith(organizationId);
    expect(deps.getCredential).not.toHaveBeenCalled();
    expect(deps.createGrant).toHaveBeenCalledWith(expect.objectContaining({
      credential: { inferenceSource: "responder" },
    }));
    expect(deps.setStatus).toHaveBeenCalledWith(expect.objectContaining({
      status: "succeeded",
    }));
  });

  it("uses the organization's key instead of Responder inference when one is connected", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.claimRun.mockResolvedValue({
      ...claimedRun(),
      harness: "claude_agent_sdk",
      model: "claude-sonnet-4.5",
      modelProvider: "anthropic",
    } as never);
    deps.selectCredential.mockResolvedValue("81818181-8181-4181-8181-818181818181");
    deps.getCredential.mockResolvedValue({ apiKey: "customer-anthropic-secret", provider: "anthropic" });
    deps.listProviderModels.mockResolvedValue([{ id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" }]);
    deps.runClaude.mockResolvedValue({ eventStream: "" });

    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);

    expect(deps.checkAllowance).not.toHaveBeenCalled();
    expect(deps.getCredential).toHaveBeenCalledWith({ credentialId: "81818181-8181-4181-8181-818181818181", organizationId, provider: "anthropic" });
    expect(deps.listProviderModels).toHaveBeenCalledWith("anthropic", "customer-anthropic-secret");
    expect(deps.createGrant).toHaveBeenCalledWith(expect.objectContaining({
      credential: { apiKey: "customer-anthropic-secret", inferenceSource: "byok" },
      model: "claude-sonnet-4-5-20250929",
    }));
    expect(deps.runClaude).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      model: expect.objectContaining({ model: "claude-sonnet-4-5-20250929" }),
    }));
  });

  it("uses a connected ChatGPT subscription for a Codex automation", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    const authJson = JSON.stringify({ tokens: { id_token: "id", access_token: "access", refresh_token: "responder-run-only", account_id: "account" } });
    deps.claimRun.mockResolvedValue(claimedRun());
    deps.selectCredential.mockResolvedValue("91919191-9191-4191-8191-919191919191");
    deps.getCredential.mockResolvedValue({ apiKey: "subscription-context-only", provider: "openai", subscription: { credentialId: "91919191-9191-4191-8191-919191919191", authJson } });
    deps.subscriptionAuth.mockResolvedValue(authJson);
    deps.runCodex.mockResolvedValue({ eventStream: "" });

    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);

    expect(deps.checkAllowance).not.toHaveBeenCalled();
    expect(deps.subscriptionAuth).toHaveBeenCalledWith({ credentialId: "91919191-9191-4191-8191-919191919191", organizationId }, expect.any(Date));
    expect(deps.createGrant).toHaveBeenCalledWith(expect.objectContaining({ credential: { inferenceSource: "byos" } }));
    expect(deps.createSubscriptionSecret).toHaveBeenCalledWith({ accessToken: "access", runId });
  });

  it("fails instead of using Responder inference when the organization's key cannot run the model", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.claimRun.mockResolvedValue(claimedRun());
    deps.selectCredential.mockResolvedValue("81818181-8181-4181-8181-818181818181");
    deps.listProviderModels.mockResolvedValue([{ id: "gpt-4.1", name: "GPT-4.1" }]);

    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);

    expect(deps.checkAllowance).not.toHaveBeenCalled();
    expect(deps.createGrant).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith(expect.objectContaining({
      failureMessage: "gpt-5.4 is not available with the organization's OpenAI API key. Choose another model or remove the key in model settings.",
      status: "failed",
    }));
  });

  it("fails when the provider rejects the organization's key", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.claimRun.mockResolvedValue(claimedRun());
    deps.selectCredential.mockResolvedValue("81818181-8181-4181-8181-818181818181");
    deps.listProviderModels.mockRejectedValue(new ModelCatalogError(true));

    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);

    expect(deps.createGrant).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith(expect.objectContaining({
      failureMessage: "OpenAI rejected the organization's API key. Replace it in model settings.",
      status: "failed",
    }));
  });

  it("stops before the sandbox when the included usage is used up", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.claimRun.mockResolvedValue(claimedRun());
    deps.selectCredential.mockResolvedValue(null);
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

  it("stops an organization-funded run before the sandbox when sandbox time is billed", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.sandboxTimeIsBilled.mockReturnValue(true);
    deps.checkAllowance.mockResolvedValue({ allowed: false, nextResetAt: null });

    await processAutomationRun("job-1", {
      kind: "automation_run",
      queuedAt: "2026-09-22T19:00:00.000Z",
      runId,
    }, process.env, deps);

    expect(deps.checkAllowance).toHaveBeenCalledWith(organizationId);
    expect(deps.createGrant).not.toHaveBeenCalled();
    expect(deps.runInSandbox).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith(expect.objectContaining({
      failureCategory: "usage_limit_reached",
      failureMessage: expect.not.stringContaining("own model key"),
      status: "failed",
    }));
  });

  it("reports a used-up allowance when the broker stopped the harness mid-turn", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.selectCredential.mockResolvedValue(null);
    deps.runCodex.mockRejectedValue(new AutomationHarnessError("Codex automation harness failed", ""));
    deps.grantAllowanceExhausted.mockResolvedValue(true);

    await processAutomationRun("job-1", {
      kind: "automation_run",
      queuedAt: "2026-09-22T19:00:00.000Z",
      runId,
    }, process.env, deps);

    expect(deps.grantAllowanceExhausted).toHaveBeenCalledWith({
      grantId: "71717171-7171-4171-8171-717171717171",
      organizationId,
      runId,
    });
    expect(deps.reportException).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith(expect.objectContaining({
      failureCategory: "usage_limit_reached",
      failureMessage: expect.stringContaining("allowance"),
      status: "failed",
    }));
  });

  it("keeps a harness failure when the broker did not refuse for the allowance", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.selectCredential.mockResolvedValue(null);
    deps.runCodex.mockRejectedValue(new AutomationHarnessError("Codex automation harness failed", ""));

    await processAutomationRun("job-1", {
      kind: "automation_run",
      queuedAt: "2026-09-22T19:00:00.000Z",
      runId,
    }, process.env, deps);

    expect(deps.setStatus).toHaveBeenCalledWith(expect.objectContaining({
      failureCategory: "execution_failed",
      failureMessage: "Codex automation harness failed",
      status: "failed",
    }));
  });
  it("stores the transcript and summarizes the result", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.runCodex.mockImplementation(async () => {
      await deps.openPullRequest();
      return {
        eventStream: [
          "Process exited with code 0",
          "Output:",
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Fixed the flaky test." } }),
        ].join("\n"),
      };
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

  it("leaves sub-agent work out of the result summary and the conversation", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.getConversation.mockResolvedValue([
      {
        data: {
          items: [
            { kind: "message", text: "Checking both repositories." },
            { kind: "message", subagentId: "toolu_1", text: "Sub-agent notes on PR #127." },
          ],
          truncated: false,
        },
        id: 1,
        type: "transcript",
      },
      { data: { authorId: "user-1", authorName: "Ash", text: "Summarize again." }, id: 2, type: "user_message" },
    ]);

    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);

    const prompt = deps.runCodex.mock.calls[0]![1].prompt;
    expect(prompt).toContain("You:\nChecking both repositories.");
    expect(prompt).not.toContain("Sub-agent notes");
  });

  it("stores the whole transcript from the events file when the printed output was cut", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    const events = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "First finding." } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Final summary." } }),
    ].join("\n");
    deps.runInSandbox.mockImplementation(async (input) => {
      const session = {
        materializeEntry: vi.fn().mockResolvedValue(undefined),
        readFile: vi.fn(async ({ path }: { path: string }) => {
          if (path.includes("harness-events-")) return new TextEncoder().encode(events);
          throw new Error("not found");
        }),
        state: { environment: {} },
      } as unknown as DaytonaSandboxSession;
      return input.run(session, async (operation: () => Promise<unknown>) => operation());
    });
    deps.runCodex.mockResolvedValue({
      eventStream: `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "First finding." } })}\n...2048 tokens truncated...`,
    });

    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);

    const stored = [...deps.appendEvent.mock.calls, ...deps.updateEvent.mock.calls]
      .map(([event]) => event)
      .filter((event) => (event as { type?: string }).type === "transcript" || !("type" in (event as object)))
      .map((event) => (event as { data: { items: Array<{ text?: string }>; truncated: boolean } }).data)
      .at(-1)!;
    expect(stored.items.map((item) => item.text)).toEqual(["First finding.", "Final summary."]);
    expect(stored.truncated).toBe(false);
  });

  it("gives a follow-up turn the earlier conversation", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.getConversation.mockResolvedValue([
      { data: { items: [{ kind: "message", text: "The deploy config is wrong." }], truncated: false }, id: 1, type: "transcript" },
      { data: { authorId: "user-1", authorName: "Ash", text: "Please add a regression test." }, id: 2, type: "user_message" },
    ]);

    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);

    expect(deps.getConversation).toHaveBeenCalledWith(runId);
    const prompt = deps.runCodex.mock.calls[0]![1].prompt as string;
    expect(prompt).toContain("This run continues an earlier conversation.");
    expect(prompt).toContain("You:\nThe deploy config is wrong.");
    expect(prompt.trimEnd()).toMatch(/Workspace member Ash:\nPlease add a regression test\.$/u);
  });

  it("gives a first turn the Slack replies that arrived while it was queued", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.getConversation.mockResolvedValue([
      {
        data: { authorId: "U123", authorName: "Ada", externalEventId: "C123:2.0", source: "slack", text: "Also check the staging deploy." },
        id: 3,
        type: "user_message",
      },
    ]);

    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);

    expect(deps.runCodex.mock.calls[0]![1].prompt).toContain("Slack reply from Ada (<@U123>):\nAlso check the staging deploy.");
  });

  it("does not add a conversation to a first turn", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    deps.getConversation.mockResolvedValue([
      { data: { authorId: "user-1", authorName: "Ash", text: "Try the checkout flow." }, id: 1, type: "user_message" },
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
    expect(types).not.toContain("action_succeeded");
  });
  it("resumes the paused sandbox of an earlier turn and pauses it again", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "sandbox-key");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    const deps = dependencies();
    const sessionState = { sandboxId: "sandbox-1" };
    deps.claimRun.mockResolvedValue({ ...claimedRun(), sandboxSessionState: sessionState });
    deps.getConversation.mockResolvedValue([
      { data: { items: [{ kind: "message", text: "Found it." }], truncated: false }, id: 1, type: "transcript" },
      { data: { authorId: "user-1", authorName: "Ash", text: "Now add a test." }, id: 2, type: "user_message" },
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
    deps.claimRun.mockResolvedValue({ ...claimedRun(), sandboxSessionState: { sandboxId: "sandbox-1" } });
    deps.getCredential.mockResolvedValue({ apiKey: "subscription-context-only", provider: "openai", subscription: { credentialId: credentialId, authJson } });
    deps.subscriptionAuth.mockResolvedValue(authJson);

    await processAutomationRun("job-1", { kind: "automation_run", queuedAt: "2026-09-22T19:00:00.000Z", runId }, process.env, deps);

    const sandboxInput = deps.runInSandbox.mock.calls[0]![0];
    expect(sandboxInput.keepPaused).toBe(false);
    expect(sandboxInput.resumeState).toBeUndefined();
    expect(deps.saveSandbox).toHaveBeenCalledWith(expect.objectContaining({ sandbox: null }));
  });
});
