import type { AutomationListItem, AutomationRunStatus } from "../automations-api";
import { providerDisplayName } from "../components/provider-glyphs";
import { scheduleLabel } from "../../../../packages/core/src/automations/schedule";


export const runStatusLabels: Record<AutomationRunStatus, string> = {
  cancelled: "Cancelled",
  failed: "Failed",
  pending: "Queued",
  running: "Running",
  succeeded: "Completed",
};

type AutomationListTrigger = AutomationListItem["triggers"][number];

export function triggerProviderLabel(trigger: AutomationListTrigger): string {
  return providerDisplayName(trigger.kind);
}

// Names the first trigger's provider and counts the others.
export function triggerSummary(triggers: AutomationListTrigger[]): string {
  const first = triggers[0];
  if (!first) return "None";
  const label = triggerProviderLabel(first);
  return triggers.length > 1 ? `${label} +${triggers.length - 1}` : label;
}

export function triggerNames(triggers: AutomationListTrigger[]): string {
  return triggers.map((trigger) => `${triggerProviderLabel(trigger)}: ${triggerEventLabel(trigger)}`).join(", ");
}

export function triggerEventLabel(trigger: AutomationListTrigger): string {
  if (trigger.kind === "slack") {
    if (trigger.eventMode === "mentions") return "App mentioned";
    if (trigger.eventMode === "every_message") return "New message";
    return "Message or mention";
  }
  if (trigger.kind === "schedule") return scheduleLabel(trigger);
  if (trigger.kind === "sentry") {
    if (trigger.eventTypes.length > 1) return "New issue or regression";
    return trigger.eventTypes[0] === "regression" ? "Issue regression" : "New issue";
  }
  return "Command in channel";
}

export function connectorSummary(connectors: string[]): string {
  if (connectors.length === 0) return "None";
  const first = providerDisplayName(connectors[0]!);
  return connectors.length > 1 ? `${first} +${connectors.length - 1}` : first;
}

export function connectorNames(connectors: string[]): string {
  return connectors.map(providerDisplayName).join(", ");
}

// The heading of a trigger card on the automation page.
export function triggerTitle(trigger: AutomationListTrigger): string {
  if (trigger.kind === "slack") {
    if (trigger.eventMode === "every_message") return "Slack message posted";
    return trigger.eventMode === "mentions" ? "Slack app mentioned" : "Slack message posted or app mentioned";
  }
  if (trigger.kind === "sentry") {
    if (trigger.eventTypes.length === 2) return "Sentry new issue or regression";
    return trigger.eventTypes[0] === "regression" ? "Sentry issue regression" : "Sentry new issue";
  }
  return trigger.kind === "discord" ? "Discord automation command" : "Schedule";
}
