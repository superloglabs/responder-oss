import type { AutomationListItem, AutomationRunStatus } from "../automations-api";
import { providerDisplayName } from "../components/provider-glyphs";


export const runStatusLabels: Record<AutomationRunStatus, string> = {
  cancelled: "Cancelled",
  failed: "Failed",
  pending: "Queued",
  running: "Running",
  succeeded: "Completed",
};

export function triggerProviderLabel(trigger: AutomationListItem["trigger"]): string {
  return providerDisplayName(trigger.kind);
}

export function triggerEventLabel(trigger: AutomationListItem["trigger"]): string {
  if (trigger.kind === "slack") {
    if (trigger.eventMode === "mentions") return "App mentioned";
    if (trigger.eventMode === "every_message") return "New message";
    return "Message or mention";
  }
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
