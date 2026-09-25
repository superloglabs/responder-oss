import { z } from "zod";
import type { AutomationTrigger } from "./config.js";

// Slugs are 16 URL-safe characters from 12 random bytes.
export const sharedAutomationTemplateSlugSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16}$/u);

// Context providers a recipient can connect for an automation. GitHub is
// listed separately because it comes from repositories, not context accounts.
const shareableContextProviders = new Set([
  "custom_mcp",
  "datadog",
  "sentry",
  "slack",
]);

// Removes everything that identifies the owner's workspace from triggers: the
// connection, the channels, and the projects. Schedules keep their timing and
// run in the recipient's time zone once applied.
export function shareableAutomationTriggers(
  triggers: AutomationTrigger[],
): AutomationTrigger[] {
  return triggers.map((trigger): AutomationTrigger => {
    if (trigger.kind === "slack") {
      return { channelIds: [], eventMode: trigger.eventMode, integrationAccountId: "", kind: "slack" };
    }
    if (trigger.kind === "sentry") {
      return { eventTypes: trigger.eventTypes, integrationAccountId: "", kind: "sentry", projectIds: [] };
    }
    if (trigger.kind === "discord") {
      return { channelIds: [], integrationAccountId: "", kind: "discord" };
    }
    return { frequency: trigger.frequency, hour: trigger.hour, kind: "schedule", timezone: "UTC", weekday: trigger.weekday };
  });
}

// Lists GitHub first when the automation uses repositories, then each other
// provider once in alphabetical order. Trigger providers are not repeated.
export function shareableAutomationConnectors(input: {
  contextProviders: string[];
  hasRepositories: boolean;
  triggers: AutomationTrigger[];
}): string[] {
  const triggerKinds = new Set<string>(input.triggers.map((trigger) => trigger.kind));
  const providers = [...new Set(input.contextProviders)]
    .filter((provider) => shareableContextProviders.has(provider) && !triggerKinds.has(provider))
    .sort((left, right) => left.localeCompare(right));
  return input.hasRepositories ? ["github", ...providers] : providers;
}
