import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimAutomationSuggestionDay: vi.fn(),
  completeAutomationSuggestionDay: vi.fn(),
  deleteOldAutomationSuggestions: vi.fn(),
  failAutomationSuggestionDay: vi.fn(),
  getAutomationSuggestionContext: vi.fn(),
  listOrganizationsDueForAutomationSuggestions: vi.fn(),
}));

vi.mock("@responder/core/db/automation-template-suggestions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@responder/core/db/automation-template-suggestions")>()),
  ...mocks,
}));

import {
  automationSuggestionModel,
  generateAutomationSuggestions,
  generateDueAutomationSuggestions,
} from "./automation-template-suggestions.js";

const organizationId = "17171717-1717-4717-8717-171717171717";
const now = new Date("2026-10-16T06:00:00.000Z");
const context = {
  automations: [{ description: "", name: "Fix regressions" }],
  connectedProviders: ["github", "slack"],
  previousSuggestions: [],
  recentIssues: [{ severity: "high", title: "Checkout returns 500" }],
  repositories: ["acme/web"],
  workspaceName: "Acme",
};

function model(text: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ text, type: "text" }],
      finishReason: { raw: undefined, unified: "stop" },
      usage: {
        inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 10, total: 10 },
        outputTokens: { reasoning: undefined, text: 20, total: 20 },
      },
      warnings: [],
    }),
  });
}

const answer = JSON.stringify({
  suggestions: [
    {
      category: "bug_triage",
      connectors: ["github"],
      description: "When checkout errors are reported in Slack, find the cause.",
      name: "Investigate checkout errors",
      prompt: "Find the cause of the reported checkout error.",
      reason: "Checkout returned 500 errors this week.",
      trigger: { eventMode: "mentions", kind: "slack" },
    },
    {
      category: "support",
      connectors: [],
      description: "Answer Discord questions.",
      name: "Answer Discord questions",
      prompt: "Answer the question.",
      reason: "You have a community.",
      trigger: { kind: "discord" },
    },
  ],
});

describe("automation template suggestions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAutomationSuggestionContext.mockResolvedValue(context);
  });

  it("stores the templates the model wrote for connected providers", async () => {
    const languageModel = model(answer);

    await generateAutomationSuggestions({ day: "2026-10-16", model: languageModel, now, organizationId });

    expect(mocks.completeAutomationSuggestionDay).toHaveBeenCalledWith({
      day: "2026-10-16",
      organizationId,
      templates: [expect.objectContaining({
        name: "Investigate checkout errors",
        triggers: [{ channelIds: [], eventMode: "mentions", integrationAccountId: "", kind: "slack" }],
      })],
    });
    const call = languageModel.doGenerateCalls[0];
    expect(JSON.stringify(call?.prompt)).toContain("Checkout returns 500 (high)");
  });

  it("records a failed day when the answer does not match the schema", async () => {
    await generateAutomationSuggestions({ day: "2026-10-16", model: model("not json"), now, organizationId });

    expect(mocks.completeAutomationSuggestionDay).not.toHaveBeenCalled();
    expect(mocks.failAutomationSuggestionDay).toHaveBeenCalledWith(expect.objectContaining({ day: "2026-10-16", organizationId }));
  });

  it("needs Responder's AI Gateway key", () => {
    expect(automationSuggestionModel({})).toBeNull();
    expect(automationSuggestionModel({ AI_GATEWAY_API_KEY: "key" })).not.toBeNull();
  });

  it("waits for the morning and skips days another worker claimed", async () => {
    await generateDueAutomationSuggestions({ AI_GATEWAY_API_KEY: "key" }, new Date("2026-10-16T04:59:00.000Z"));
    expect(mocks.listOrganizationsDueForAutomationSuggestions).not.toHaveBeenCalled();

    mocks.listOrganizationsDueForAutomationSuggestions.mockResolvedValue([organizationId]);
    mocks.claimAutomationSuggestionDay.mockResolvedValue(false);
    await generateDueAutomationSuggestions({ AI_GATEWAY_API_KEY: "key" }, now);

    expect(mocks.listOrganizationsDueForAutomationSuggestions).toHaveBeenCalledWith(expect.objectContaining({ day: "2026-10-16" }));
    expect(mocks.getAutomationSuggestionContext).not.toHaveBeenCalled();
    expect(mocks.deleteOldAutomationSuggestions).toHaveBeenCalledWith(now);
  });
});
