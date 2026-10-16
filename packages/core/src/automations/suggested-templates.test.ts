import { describe, expect, it } from "vitest";
import { automationTriggerSchema } from "./config.js";
import {
  automationSuggestionPrompt,
  suggestedAutomationTemplates,
  type AutomationSuggestionOutput,
} from "./suggested-templates.js";

type Suggestion = AutomationSuggestionOutput["suggestions"][number];

function suggestion(overrides: Partial<Suggestion>): Suggestion {
  return {
    category: "scans",
    connectors: ["github"],
    description: "Each Monday, list flaky tests.",
    name: "Find flaky tests",
    prompt: "List tests that failed and passed on retry this week.",
    reason: "You have three repositories with CI.",
    trigger: { frequency: "weekly", hour: 9, kind: "schedule", weekday: 1 },
    ...overrides,
  };
}

let nextId = 0;
const newId = () => `suggestion-${++nextId}`;

describe("suggested automation templates", () => {
  it("builds templates with empty trigger targets", () => {
    const [template] = suggestedAutomationTemplates({
      suggestions: [suggestion({
        connectors: ["sentry", "github", "Slack", "posthog"],
        trigger: { eventTypes: ["regression", "regression"], kind: "sentry" },
      })],
    }, { connectedProviders: ["github", "sentry", "slack"], takenNames: [] }, () => "id-1");

    expect(template).toEqual({
      category: "scans",
      connectors: ["sentry", "github", "slack"],
      description: "Each Monday, list flaky tests.",
      id: "id-1",
      name: "Find flaky tests",
      prompt: "List tests that failed and passed on retry this week.",
      reason: "You have three repositories with CI.",
      triggers: [{ eventTypes: ["regression"], integrationAccountId: "", kind: "sentry", projectIds: [] }],
    });
  });

  it("drops suggestions whose trigger provider is not connected", () => {
    const templates = suggestedAutomationTemplates({
      suggestions: [
        suggestion({ name: "Answer Discord questions", trigger: { kind: "discord" } }),
        suggestion({ name: "Review merged pull requests", trigger: { eventTypes: ["merged"], kind: "github" } }),
      ],
    }, { connectedProviders: ["github"], takenNames: [] }, newId);

    expect(templates.map((template) => template.name)).toEqual(["Review merged pull requests"]);
  });

  it("skips names that are taken or repeated and keeps three", () => {
    const templates = suggestedAutomationTemplates({
      suggestions: [
        suggestion({ name: "Triage alerts in Slack" }),
        suggestion({ name: "One" }),
        suggestion({ name: "one" }),
        suggestion({ name: "Two" }),
        suggestion({ name: "Three" }),
        suggestion({ name: "Four" }),
      ],
    }, { connectedProviders: ["github"], takenNames: ["triage alerts in slack"] }, newId);

    expect(templates.map((template) => template.name)).toEqual(["One", "Two", "Three"]);
  });

  it("produces schedules the automation schema accepts", () => {
    const [template] = suggestedAutomationTemplates({
      suggestions: [suggestion({ trigger: { frequency: "weekly", hour: 27, kind: "schedule", weekday: -1 } })],
    }, { connectedProviders: [], takenNames: [] }, newId);

    expect(template?.triggers).toEqual([{ frequency: "weekly", hour: 23, kind: "schedule", timezone: "UTC", weekday: 0 }]);
    expect(automationTriggerSchema.safeParse(template?.triggers[0]).success).toBe(true);
    expect(template?.connectors).toEqual([]);
  });

  it("lists the workspace in the prompt", () => {
    const prompt = automationSuggestionPrompt({
      automations: [{ description: "Fixes Sentry regressions.", name: "Fix regressions" }],
      connectedProviders: ["github", "sentry"],
      previousSuggestions: ["Find flaky tests"],
      recentIssues: [{ severity: "high", title: "Checkout returns 500" }],
      repositories: ["acme/web"],
      workspaceName: "Acme",
    }, [{ description: "Answers questions.", name: "Answer support questions" }]);

    expect(prompt).toContain("Workspace: Acme");
    expect(prompt).toContain("- acme/web");
    expect(prompt).toContain("- Fix regressions: Fixes Sentry regressions.");
    expect(prompt).toContain("- Checkout returns 500 (high)");
    expect(prompt).toContain("Suggested on previous days:\n- Find flaky tests");
  });
});
