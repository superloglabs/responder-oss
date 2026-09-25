import { describe, expect, it } from "vitest";
import type { AutomationConfiguration, AutomationOptions } from "../automations-api";
import { automationConnectorProviders } from "../components/automation-connectors";
import { applyAutomationTemplate, automationTemplateMissingFields, automationTemplates, findAutomationTemplate, suggestedAutomationTemplates } from "./automation-templates";

const configuration = {
  contextAccountIds: ["previous"],
  model: "gpt-5.4",
  prompt: "",
  repositoryIds: ["repository"],
  triggers: [],
} as unknown as AutomationConfiguration;
const options = (accounts: Array<{ id: string; provider: string }>) => ({ accounts }) as unknown as AutomationOptions;

describe("automation templates", () => {
  it("has unique ids and covers every category", () => {
    expect(new Set(automationTemplates.map((template) => template.id)).size).toBe(automationTemplates.length);
    for (const category of ["support", "bug_triage", "scans"]) {
      expect(automationTemplates.filter((template) => template.category === category).length).toBeGreaterThan(0);
    }
  });

  it("uses only connectors an automation run can use, apart from the trigger", () => {
    for (const template of automationTemplates) {
      expect(template.connectors.every((provider) => automationConnectorProviders.includes(provider))).toBe(true);
      for (const trigger of template.triggers) expect(template.connectors).not.toContain(trigger.kind);
      expect(template.prompt.trim()).not.toBe("");
    }
  });

  it("suggests six templates in a fixed order", () => {
    expect(suggestedAutomationTemplates.map((template) => template.id)).toEqual([
      "answer-community-questions",
      "triage-sentry-issues",
      "reliability-check",
      "review-observability",
      "answer-support-questions",
      "review-performance",
    ]);
  });

  it("finds templates by id", () => {
    expect(findAutomationTemplate("triage-sentry-issues")?.name).toBe("Triage new Sentry issues");
    expect(findAutomationTemplate("unknown")).toBeUndefined();
    expect(findAutomationTemplate(null)).toBeUndefined();
  });

  it("fills the trigger, prompt, and connectors from existing connections", () => {
    const template = findAutomationTemplate("triage-sentry-issues")!;
    const applied = applyAutomationTemplate(configuration, template, options([
      { id: "sentry-1", provider: "sentry" },
      { id: "sentry-2", provider: "sentry" },
      { id: "slack-1", provider: "slack" },
      { id: "github-1", provider: "github" },
    ]));
    expect(applied.triggers).toEqual([{ eventTypes: ["new_issue"], integrationAccountId: "sentry-1", kind: "sentry", projectIds: [] }]);
    expect(applied.contextAccountIds).toEqual(["slack-1"]);
    expect(applied.prompt).toBe(template.prompt);
    expect(applied.repositoryIds).toEqual(["repository"]);
    expect(applied.model).toBe("gpt-5.4");
  });

  it("runs scheduled templates in the member's time zone without a trigger connection", () => {
    const template = findAutomationTemplate("reliability-check")!;
    const applied = applyAutomationTemplate(configuration, template, options([
      { id: "sentry-1", provider: "sentry" },
      { id: "datadog-1", provider: "datadog" },
      { id: "slack-1", provider: "slack" },
    ]), "Europe/London");
    expect(applied.triggers).toEqual([{ frequency: "hourly", hour: 9, kind: "schedule", timezone: "Europe/London", weekday: 1 }]);
    expect(applied.contextAccountIds).toEqual(["sentry-1", "datadog-1", "slack-1"]);
    expect(findAutomationTemplate("review-architecture")!.triggers[0]).toMatchObject({ frequency: "weekly", kind: "schedule" });
  });

  it("leaves missing connections for the user to connect", () => {
    const applied = applyAutomationTemplate(configuration, findAutomationTemplate("fix-sentry-regressions")!, options([]));
    expect(applied.triggers[0]).toMatchObject({ eventTypes: ["regression"], integrationAccountId: "", kind: "sentry" });
    expect(applied.contextAccountIds).toEqual([]);
  });

  it("does not add the trigger connection as a connector", () => {
    const applied = applyAutomationTemplate(configuration, findAutomationTemplate("match-reports-to-errors")!, options([
      { id: "slack-1", provider: "slack" },
      { id: "sentry-1", provider: "sentry" },
    ]));
    expect(applied.triggers[0]).toMatchObject({ eventMode: "mentions", integrationAccountId: "slack-1", kind: "slack" });
    expect(applied.contextAccountIds).toEqual(["sentry-1"]);
  });

  it("fills every trigger of a shared template", () => {
    const applied = applyAutomationTemplate(configuration, {
      connectors: ["github", "slack"],
      description: "",
      name: "Shared",
      prompt: "Do it.",
      triggers: [
        { eventTypes: ["new_issue"], integrationAccountId: "", kind: "sentry", projectIds: [] },
        { channelIds: [], eventMode: "mentions", integrationAccountId: "", kind: "slack" },
        { frequency: "daily", hour: 8, kind: "schedule", timezone: "UTC", weekday: 1 },
      ],
    }, options([
      { id: "sentry-1", provider: "sentry" },
      { id: "slack-1", provider: "slack" },
    ]), "Asia/Tokyo");
    expect(applied.triggers).toEqual([
      { eventTypes: ["new_issue"], integrationAccountId: "sentry-1", kind: "sentry", projectIds: [] },
      { channelIds: [], eventMode: "mentions", integrationAccountId: "slack-1", kind: "slack" },
      { frequency: "daily", hour: 8, kind: "schedule", timezone: "Asia/Tokyo", weekday: 1 },
    ]);
    // Slack is already the trigger connection, so it is not added again.
    expect(applied.contextAccountIds).toEqual([]);
  });

  it("lists what the user still chooses for each trigger", () => {
    expect(automationTemplateMissingFields({ triggers: [{ frequency: "daily", hour: 8, kind: "schedule", timezone: "UTC", weekday: 1 }] })).toBe("a repository");
    expect(automationTemplateMissingFields(findAutomationTemplate("triage-sentry-issues")!)).toBe("a Sentry project and a repository");
    expect(automationTemplateMissingFields({ triggers: [
      { eventTypes: ["new_issue"], integrationAccountId: "", kind: "sentry", projectIds: [] },
      { channelIds: [], eventMode: "mentions", integrationAccountId: "", kind: "slack" },
      { channelIds: [], eventMode: "every_message", integrationAccountId: "", kind: "slack" },
    ] })).toBe("a Sentry project, a Slack channel, and a repository");
  });
});
