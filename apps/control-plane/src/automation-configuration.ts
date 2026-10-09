import type { AutomationConfiguration, AutomationOptions, AutomationTrigger } from "./automations-api";
import { cronProblem, maxCronLength, type AutomationScheduleFrequency } from "../../../packages/core/src/automations/schedule";
import { maxSlackPhrases, slackPhraseError } from "../../../packages/core/src/automations/slack-phrases";

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

// Leaving a custom schedule drops its expression, so choosing custom again
// converts the preset timing the member set since.
export function withScheduleFrequency(trigger: ScheduleTrigger, frequency: AutomationScheduleFrequency): ScheduleTrigger {
  if (frequency === "custom") return { ...trigger, cron: trigger.frequency === "custom" ? trigger.cron : scheduleCron(trigger), frequency };
  const preset: ScheduleTrigger = { ...trigger, frequency };
  delete preset.cron;
  return preset;
}

const cronProblemMessages = {
  field_count: "Use five fields: minute, hour, day of month, month, day of week.",
  never_runs: "This date never occurs.",
  too_long: `Use ${maxCronLength} characters or fewer.`,
  value: "Use minute 0-59, hour 0-23, day 1-31, month 1-12, and day of week 0-7.",
} as const;

// Why a custom schedule's expression cannot be saved, or null when it can.
export function scheduleCronError(trigger: ScheduleTrigger): string | null {
  if (trigger.frequency !== "custom") return null;
  const problem = cronProblem(trigger.cron ?? "");
  return problem ? cronProblemMessages[problem] : null;
}

export function isScheduleComplete(trigger: ScheduleTrigger): boolean {
  return scheduleCronError(trigger) === null;
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

// The phrases a Slack trigger ignores, one per line. Blank and repeated lines
// are dropped.
export function slackPhrasesFromText(text: string): string[] | undefined {
  const phrases = [...new Set(text.split("\n").map((line) => line.trim()).filter(Boolean))];
  return phrases.length ? phrases : undefined;
}

// Why a Slack trigger's ignored phrases cannot be saved, or null when they can.
export function slackPhrasesError(phrases: string[] | undefined): string | null {
  if (!phrases) return null;
  if (phrases.length > maxSlackPhrases) return `Use ${maxSlackPhrases} phrases or fewer.`;
  for (const phrase of phrases) {
    const error = slackPhraseError(phrase);
    if (error) return error;
  }
  return null;
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
