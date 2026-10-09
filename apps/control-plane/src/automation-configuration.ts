import type { AutomationConfiguration, AutomationOptions, AutomationTrigger } from "./automations-api";
import { isValidCron, type AutomationScheduleFrequency } from "../../../packages/core/src/automations/schedule";

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

type ScheduleTrigger = Extract<AutomationTrigger, { kind: "schedule" }>;

// New schedules run at 09:00, on Mondays when weekly and on weekdays when
// custom, in the member's time zone.
export function defaultScheduleTrigger(frequency: AutomationScheduleFrequency, timezone = browserTimeZone()): ScheduleTrigger {
  const trigger: ScheduleTrigger = { frequency, hour: 9, kind: "schedule", timezone, weekday: 1 };
  return frequency === "custom" ? { ...trigger, cron: "0 9 * * 1-5" } : trigger;
}

// The cron expression for a schedule's current timing, so switching to a
// custom schedule starts from what the member already chose.
export function scheduleCron(trigger: ScheduleTrigger): string {
  if (trigger.frequency === "custom") return trigger.cron ?? "";
  if (trigger.frequency === "hourly") return "0 * * * *";
  return `0 ${trigger.hour} * * ${trigger.frequency === "weekly" ? trigger.weekday : "*"}`;
}

export function isScheduleComplete(trigger: ScheduleTrigger): boolean {
  return trigger.frequency !== "custom" || isValidCron(trigger.cron ?? "");
}

// Saved automation settings can reference connections, trigger resources,
// repositories, secrets, or skills that were removed since. The page cannot show them
// and the server rejects them, so keep only what the current options offer.
// Options hold connected accounts and available resources, which is what the
// server accepts.
export function availableAutomationConfiguration(
  configuration: AutomationConfiguration,
  options: AutomationOptions,
): AutomationConfiguration {
  return {
    ...configuration,
    contextAccountIds: configuration.contextAccountIds.filter((id) => options.accounts.some((account) => account.id === id)),
    repositoryIds: configuration.repositoryIds.filter((id) => options.repositories.some((repository) => repository.id === id)),
    skillIds: configuration.skillIds.filter((id) => options.skills.some((skill) => skill.id === id)),
    triggers: configuration.triggers.map((trigger) => availableTrigger(trigger, options)),
    workspaceSecretIds: configuration.workspaceSecretIds.filter((id) => options.secrets.some((secret) => secret.id === id)),
  };
}

function availableTrigger(trigger: AutomationTrigger, options: AutomationOptions): AutomationTrigger {
  if (trigger.kind === "schedule") return trigger;
  const triggerAccountAvailable = options.accounts.some((account) =>
    account.id === trigger.integrationAccountId && account.provider === trigger.kind
  );
  if (trigger.kind === "axiom") {
    return { ...trigger, integrationAccountId: triggerAccountAvailable ? trigger.integrationAccountId : "" };
  }
  const resourceKind = trigger.kind === "sentry" ? "sentry_project" : trigger.kind === "discord" ? "discord_channel" : "slack_channel";
  const resourceIds = new Set(options.resources
    .filter((resource) => triggerAccountAvailable && resource.integrationAccountId === trigger.integrationAccountId && resource.kind === resourceKind)
    .map((resource) => resource.externalId));
  const integrationAccountId = triggerAccountAvailable ? trigger.integrationAccountId : "";
  return trigger.kind === "sentry"
    ? { ...trigger, integrationAccountId, projectIds: trigger.projectIds.filter((id) => resourceIds.has(id)) }
    : { ...trigger, integrationAccountId, channelIds: trigger.channelIds.filter((id) => resourceIds.has(id)) };
}

// Returns whether a trigger has everything the server needs to accept it.
export function isTriggerComplete(trigger: AutomationTrigger): boolean {
  if (trigger.kind === "schedule") return isScheduleComplete(trigger);
  if (!trigger.integrationAccountId) return false;
  if (trigger.kind === "axiom") return true;
  return trigger.kind === "sentry" ? trigger.projectIds.length > 0 && trigger.eventTypes.length > 0 : trigger.channelIds.length > 0;
}

// The environments a Sentry trigger offers: those Sentry lists, then any the
// trigger excludes that Sentry no longer lists.
export function sentryEnvironmentChoices(environments: string[], excluded: string[]): string[] {
  return [...environments, ...excluded.filter((environment) => !environments.includes(environment))];
}

// A trigger stores the environments left unchecked, so environments added in
// Sentry later start runs. Returns undefined when every environment is checked.
export function excludedSentryEnvironments(choices: string[], checked: string[]): string[] | undefined {
  const excluded = choices.filter((environment) => !checked.includes(environment));
  return excluded.length ? excluded : undefined;
}

// Moves `value` to `index`, keeping the order of the other items.
export function moveItem<T>(list: T[], value: T, index: number): T[] {
  const rest = list.filter((item) => item !== value);
  if (rest.length === list.length) return list;
  const target = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, target), value, ...rest.slice(target)];
}
