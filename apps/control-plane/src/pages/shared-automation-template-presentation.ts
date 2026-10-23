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
  if (trigger.kind === "errors") {
    const events = trigger.eventTypes.length > 1
      ? "a new error or an error that occurs again after being resolved"
      : trigger.eventTypes[0] === "regression" ? "an error that occurs again after being resolved" : "a new error";
    return `When your telemetry shows ${events}`;
  }
  if (trigger.kind === "axiom") return "When an Axiom monitor sends an alert to its Responder notifier";
  if (trigger.kind === "signoz") return "When a SigNoz alert that uses the Responder channel fires";
  if (trigger.kind === "honeycomb") return "When a Honeycomb trigger or SLO burn alert that notifies the Responder webhook fires";
  if (trigger.kind === "betterstack") return "When a Better Stack incident starts and its outgoing webhook notifies Responder";
  if (trigger.kind === "devrev") return "When a ticket is created in DevRev";
  if (trigger.kind === "github") {
    const events = trigger.eventTypes.length > 1
      ? "opened or merged"
      : trigger.eventTypes[0] === "merged" ? "merged" : "opened";
    return `When a pull request is ${events} in a GitHub repository you choose`;
  }
  if (trigger.kind === "discord") return "When someone runs /automate in a Discord channel you choose";
  if (trigger.kind === "webhook") return "When a request reaches the automation's webhook URL";
  return `${scheduleLabel(trigger)}, in your time zone`;
}

export function sharedTemplateSetupPath(slug: string): string {
  return `/automations/new?shared=${encodeURIComponent(slug)}`;
}

export function builtInTemplateSetupPath(id: string): string {
  return `/automations/new?template=${encodeURIComponent(id)}`;
}

// The create page a visitor opens from a shared or built-in template, or null
// elsewhere. Sign-up and workspace creation return the visitor to it.
export function automationSetupReturnPath(location: Pick<Location, "pathname" | "search">): string | null {
  if (location.pathname !== "/automations/new") return null;
  const params = new URLSearchParams(location.search);
  const slug = params.get("shared");
  if (slug) return sharedTemplateSetupPath(slug);
  const templateId = params.get("template");
  return templateId ? builtInTemplateSetupPath(templateId) : null;
}
