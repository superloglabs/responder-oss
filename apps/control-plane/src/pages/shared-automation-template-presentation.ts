import type { AutomationTrigger } from "../automations-api";
import { scheduleLabel } from "../../../../packages/core/src/automations/schedule";

// Describes when a shared template's trigger starts a run, for a visitor who
// has not connected anything yet.
export function sharedTriggerDescription(trigger: AutomationTrigger): string {
  if (trigger.kind === "slack") {
    if (trigger.eventMode === "mentions") return "When someone mentions the app in a Slack channel you choose";
    if (trigger.eventMode === "every_message") return "When a message is posted in a Slack channel you choose";
    return "When a message is posted, or the app is mentioned, in a Slack channel you choose";
  }
  if (trigger.kind === "sentry") {
    const events = trigger.eventTypes.length > 1
      ? "a new issue or a regression"
      : trigger.eventTypes[0] === "regression" ? "a regression" : "a new issue";
    return `When Sentry reports ${events} in a project you choose`;
  }
  if (trigger.kind === "discord") return "When someone runs /automate in a Discord channel you choose";
  return `${scheduleLabel(trigger)}, in your time zone`;
}

export function sharedTemplateSetupPath(slug: string): string {
  return `/automations/new?shared=${encodeURIComponent(slug)}`;
}

// The create page a visitor opens from a shared template, or null elsewhere.
// Sign-up and workspace creation return the visitor to it.
export function sharedTemplateSetupReturnPath(location: Pick<Location, "pathname" | "search">): string | null {
  if (location.pathname !== "/automations/new") return null;
  const slug = new URLSearchParams(location.search).get("shared");
  return slug ? sharedTemplateSetupPath(slug) : null;
}
