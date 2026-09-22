import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addSlackReaction: vi.fn(),
  createGateway: vi.fn(),
  decryptCredentials: vi.fn(),
  evaluate: vi.fn(),
  fetchSentryIssueTriageContext: vi.fn(),
  getInitialTriageContext: vi.fn(),
  getRuntimeSentryConnection: vi.fn(),
  getSlackInvestigationLiveContext: vi.fn(),
  removeSlackReaction: vi.fn(),
  setInvestigationSlackReaction: vi.fn(),
}));

vi.mock("ai", () => ({
  createGateway: mocks.createGateway,
  experimental_evaluate: mocks.evaluate,
}));
vi.mock("@responder/core/credentials/encryption", () => ({
  decryptCredentials: mocks.decryptCredentials,
}));
vi.mock("@responder/core/db/issues", () => ({
  getSlackInvestigationLiveContext: mocks.getSlackInvestigationLiveContext,
}));
vi.mock("@responder/core/db/investigations", () => ({
  getInitialTriageContext: mocks.getInitialTriageContext,
  getRuntimeSentryConnection: mocks.getRuntimeSentryConnection,
  setInvestigationSlackReaction: mocks.setInvestigationSlackReaction,
}));
vi.mock("@responder/core/integrations/slack", () => ({
  addSlackReaction: mocks.addSlackReaction,
  INITIAL_TRIAGE_SLACK_REACTIONS: [
    "red_circle",
    "large_orange_circle",
    "large_yellow_circle",
    "large_green_circle",
  ],
  removeSlackReaction: mocks.removeSlackReaction,
}));
vi.mock("./sentry-issue-context.js", () => ({
  fetchSentryIssueTriageContext: mocks.fetchSentryIssueTriageContext,
}));

import { runInitialTriage } from "./initial-triage.js";

const investigationId = "16161616-1616-4616-8616-161616161616";
const context = {
  agentConfigVersionId: "config-version-1",
  alert: {
    attributes: { slackAlertProvider: "sentry" },
    body: "Checkout requests are returning 500 errors.",
    provider: "slack" as const,
    title: "Checkout errors",
  },
  existingReactions: [],
  recentIncidents: [
    {
      body: "A prior checkout alert.",
      createdAt: "2026-09-20T10:00:00.000Z",
      outcome: "A bad deployment caused elevated errors.",
      provider: "slack" as const,
      status: "resolved" as const,
      title: "Prior checkout errors",
    },
  ],
};

describe("initial Jev triage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getInitialTriageContext.mockResolvedValue(context);
    mocks.getRuntimeSentryConnection.mockResolvedValue({
      accessToken: "sentry-token",
      mcpUrl: "https://mcp.sentry.dev/example",
      organizationSlug: "example",
    });
    mocks.fetchSentryIssueTriageContext.mockResolvedValue({
      id: "140145603",
      status: "unresolved",
      userCount: 42,
    });
    mocks.getSlackInvestigationLiveContext.mockResolvedValue({
      source: {
        channelId: "C123",
        encryptedCredentials: "encrypted",
        reactionTimestamp: "1785500000.000100",
      },
    });
    mocks.decryptCredentials.mockReturnValue({ accessToken: "xoxb-test" });
    mocks.createGateway.mockReturnValue({
      evaluationModel: vi.fn().mockReturnValue("jev-model"),
    });
    mocks.evaluate.mockResolvedValue({
      answers: {
        priority: { choice: "red_circle", type: "choice" },
      },
    });
  });

  it("gives Jev the alert and bounded history, then records its reaction", async () => {
    await expect(
      runInitialTriage(investigationId, { AI_GATEWAY_API_KEY: "gateway-key" }),
    ).resolves.toBe("red_circle");

    expect(mocks.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRetries: 1,
        model: "jev-model",
        questions: {
          priority: expect.objectContaining({
            criteria: expect.objectContaining({
              large_green_circle: expect.stringContaining("No issue"),
              large_orange_circle: expect.stringContaining("SEV-2"),
              large_yellow_circle: expect.stringContaining("SEV-3"),
              red_circle: expect.stringContaining("SEV-1"),
            }),
          }),
        },
        state: {
          alert: context.alert,
          recentIncidents: context.recentIncidents,
          sentryIssue: {
            id: "140145603",
            status: "unresolved",
            userCount: 42,
          },
        },
      }),
    );
    expect(mocks.getRuntimeSentryConnection).toHaveBeenCalledWith(
      "config-version-1",
    );
    expect(mocks.addSlackReaction).toHaveBeenCalledWith({
      accessToken: "xoxb-test",
      channelId: "C123",
      name: "red_circle",
      timestamp: "1785500000.000100",
    });
    expect(mocks.setInvestigationSlackReaction).toHaveBeenCalledWith(
      investigationId,
      "red_circle",
      true,
    );
  });

  it("bounds alert metadata before sending it to Jev", async () => {
    mocks.getInitialTriageContext.mockResolvedValue({
      ...context,
      alert: {
        ...context.alert,
        attributes: {
          slackAlertProvider: "sentry",
          awsAlarmUrl: `https://example.com/${"a".repeat(3_000)}`,
        },
        sourceUrl: `https://example.com/${"b".repeat(3_000)}`,
        title: "t".repeat(1_000),
      },
    });

    await runInitialTriage(investigationId, {
      AI_GATEWAY_API_KEY: "gateway-key",
    });

    const state = mocks.evaluate.mock.calls[0]![0].state;
    expect(state.alert.title).toHaveLength(500);
    expect(state.alert.sourceUrl).toHaveLength(2_000);
    expect(state.alert.attributes.awsAlarmUrl).toHaveLength(2_000);
  });

  it("continues without Sentry enrichment when the lookup fails", async () => {
    mocks.fetchSentryIssueTriageContext.mockRejectedValue(
      new Error("Sentry unavailable"),
    );

    await expect(
      runInitialTriage(investigationId, { AI_GATEWAY_API_KEY: "gateway-key" }),
    ).resolves.toBe("red_circle");
    expect(mocks.evaluate.mock.calls[0]![0].state).not.toHaveProperty(
      "sentryIssue",
    );
  });

  it("does nothing when the pinned agent version has triage disabled", async () => {
    mocks.getInitialTriageContext.mockResolvedValue(null);

    await expect(runInitialTriage(investigationId, {})).resolves.toBeNull();

    expect(mocks.evaluate).not.toHaveBeenCalled();
    expect(mocks.getSlackInvestigationLiveContext).not.toHaveBeenCalled();
  });

  it("does not call Jev again after a triage reaction was recorded", async () => {
    mocks.getInitialTriageContext.mockResolvedValue({
      ...context,
      existingReactions: ["large_orange_circle"],
    });

    await expect(runInitialTriage(investigationId, {})).resolves.toBe(
      "large_orange_circle",
    );

    expect(mocks.evaluate).not.toHaveBeenCalled();
    expect(mocks.addSlackReaction).not.toHaveBeenCalled();
  });

  it("removes all triage circles and adds none when the result is unclear", async () => {
    mocks.evaluate.mockResolvedValue({
      answers: {
        priority: { choice: "unclear", type: "choice" },
      },
    });

    await expect(
      runInitialTriage(investigationId, { AI_GATEWAY_API_KEY: "gateway-key" }),
    ).resolves.toBeNull();

    expect(mocks.addSlackReaction).not.toHaveBeenCalled();
    expect(mocks.removeSlackReaction.mock.calls.map(([input]) => input.name))
      .toEqual([
        "red_circle",
        "large_orange_circle",
        "large_yellow_circle",
        "large_green_circle",
      ]);
    expect(
      mocks.setInvestigationSlackReaction.mock.calls.map(([, name, active]) => [
        name,
        active,
      ]),
    ).toEqual([
      ["red_circle", false],
      ["large_orange_circle", false],
      ["large_yellow_circle", false],
      ["large_green_circle", false],
    ]);
  });

  it("requires a gateway key only when triage is enabled", async () => {
    await expect(runInitialTriage(investigationId, {})).rejects.toThrow(
      "AI_GATEWAY_API_KEY is required",
    );
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
});
