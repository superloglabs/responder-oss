import { type AutomationConfiguration, type AutomationOptions, type AutomationTrigger, type ConnectedAutomationTrigger } from "../automations-api";
import { browserTimeZone } from "../automation-configuration";
import type { AutomationConnectorProvider } from "../components/automation-connectors";
import { builtInAutomationTemplates, type AutomationTemplateCategory } from "../../../../packages/core/src/automations/templates";

export type { AutomationTemplateCategory };

export const automationTemplateCategoryLabels: Record<AutomationTemplateCategory, string> = {
  bug_triage: "Bug triage",
  scans: "Scans",
  support: "Support",
};

// A starting point for a new automation, built in or shared by another
// workspace. Triggers have no connection or channels; the create page fills
// in the connections and the user picks the channels, projects, and
// repositories.
export interface AutomationTemplateContent {
  // Connectors for the run. A trigger's connection is added only when its
  // provider is listed here.
  connectors: string[];
  description: string;
  name: string;
  prompt: string;
  triggers: AutomationTrigger[];
}

export interface AutomationTemplate extends AutomationTemplateContent {
  category: AutomationTemplateCategory;
  connectors: AutomationConnectorProvider[];
  id: string;
}

export const automationTemplates: AutomationTemplate[] = builtInAutomationTemplates;

// Shown first, in this order, before the member picks a category.
const suggestedTemplateIds = [
  "answer-community-questions",
  "triage-sentry-issues",
  "reliability-check",
  "review-observability",
  "answer-support-questions",
  "review-performance",
];

export const suggestedAutomationTemplates = suggestedTemplateIds.flatMap((id) => automationTemplates.find((template) => template.id === id) ?? []);

export function findAutomationTemplate(id: string | null | undefined): AutomationTemplate | undefined {
  return id ? automationTemplates.find((template) => template.id === id) : undefined;
}

// Applies a template to a new automation. Triggers and connectors use the
// first connection of each provider; missing connections are left for the
// user to connect from the page. Schedules run in `timezone`.
export function applyAutomationTemplate(configuration: AutomationConfiguration, template: AutomationTemplateContent, options: AutomationOptions, timezone = browserTimeZone()): AutomationConfiguration {
  const triggers = template.triggers.map((trigger): AutomationTrigger => trigger.kind === "schedule"
    ? { ...trigger, timezone }
    : { ...trigger, integrationAccountId: options.accounts.find((account) => account.provider === trigger.kind)?.id ?? "" });
  const contextAccountIds = template.connectors.flatMap((provider) => {
    const account = options.accounts.find((candidate) => candidate.provider === provider);
    return provider === "github" || !account ? [] : [account.id];
  });
  return { ...configuration, contextAccountIds, prompt: template.prompt, triggers };
}

// Axiom alerts and DevRev tickets arrive at the connection's webhook, so there
// is nothing to choose.
const triggerResources: Record<ConnectedAutomationTrigger["kind"], string | null> = {
  axiom: null,
  devrev: null,
  discord: "a Discord channel",
  github: "a GitHub repository",
  sentry: "a Sentry project",
  slack: "a Slack channel",
};

// What the user still chooses after applying a template, for the page notice.
export function automationTemplateMissingFields(template: Pick<AutomationTemplateContent, "triggers">): string {
  const resources = [...new Set(template.triggers.flatMap((trigger) => trigger.kind === "schedule" ? [] : [triggerResources[trigger.kind] ?? []].flat()))];
  const fields = [...resources, "a repository"];
  return fields.length > 2 ? `${fields.slice(0, -1).join(", ")}, and a repository` : fields.join(" and ");
}
