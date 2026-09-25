import { describe, expect, it } from "vitest";
import type { AutomationConfiguration, AutomationOptions } from "../automations-api";
import { automationConnectorProviders } from "../components/automation-connectors";
import { applyAutomationTemplate, automationTemplates, findAutomationTemplate } from "./automation-templates";

const configuration = {
  contextAccountIds: ["previous"],
  model: "gpt-5.4",
  prompt: "",
  repositoryIds: ["repository"],
  trigger: { channelIds: [], eventMode: "mentions", integrationAccountId: "", kind: "slack" },
} as unknown as AutomationConfiguration;
const options = (accounts: Array<{ id: string; provider: string }>) => ({ accounts }) as unknown as AutomationOptions;

describe("automation templates", () => {
  it("has unique ids and covers support and bug triage", () => {
    expect(new Set(automationTemplates.map((template) => template.id)).size).toBe(automationTemplates.length);
    expect(automationTemplates.filter((template) => template.category === "support").length).toBeGreaterThan(0);
    expect(automationTemplates.filter((template) => template.category === "bug_triage").length).toBeGreaterThan(0);
  });

  it("uses only connectors an automation run can use, apart from the trigger", () => {
    for (const template of automationTemplates) {
      expect(template.connectors.every((provider) => automationConnectorProviders.includes(provider))).toBe(true);
      expect(template.connectors).not.toContain(template.trigger.kind);
      expect(template.prompt.trim()).not.toBe("");
    }
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
    expect(applied.trigger).toEqual({ eventTypes: ["new_issue"], integrationAccountId: "sentry-1", kind: "sentry", projectIds: [] });
    expect(applied.contextAccountIds).toEqual(["slack-1"]);
    expect(applied.prompt).toBe(template.prompt);
    expect(applied.repositoryIds).toEqual(["repository"]);
    expect(applied.model).toBe("gpt-5.4");
  });

  it("leaves missing connections for the user to connect", () => {
    const applied = applyAutomationTemplate(configuration, findAutomationTemplate("fix-sentry-regressions")!, options([]));
    expect(applied.trigger).toMatchObject({ eventTypes: ["regression"], integrationAccountId: "", kind: "sentry" });
    expect(applied.contextAccountIds).toEqual([]);
  });

  it("does not add the trigger connection as a connector", () => {
    const applied = applyAutomationTemplate(configuration, findAutomationTemplate("match-reports-to-errors")!, options([
      { id: "slack-1", provider: "slack" },
      { id: "sentry-1", provider: "sentry" },
    ]));
    expect(applied.trigger).toMatchObject({ eventMode: "mentions", integrationAccountId: "slack-1", kind: "slack" });
    expect(applied.contextAccountIds).toEqual(["sentry-1"]);
  });
});
