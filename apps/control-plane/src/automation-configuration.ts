import type { AutomationConfiguration, AutomationOptions, AutomationTrigger } from "./automations-api";
import type { AutomationScheduleFrequency } from "../../../packages/core/src/automations/schedule";

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

// New schedules run at 09:00, on Mondays when weekly, in the member's time zone.
export function defaultScheduleTrigger(frequency: AutomationScheduleFrequency, timezone = browserTimeZone()): Extract<AutomationTrigger, { kind: "schedule" }> {
  return { frequency, hour: 9, kind: "schedule", timezone, weekday: 1 };
}

// Saved automation settings can reference connections, trigger resources,
// repositories, or secrets that were removed since. The page cannot show them
// and the server rejects them, so keep only what the current options offer.
// Options hold connected accounts and available resources, which is what the
// server accepts.
export function availableAutomationConfiguration(
  configuration: AutomationConfiguration,
  options: AutomationOptions,
): AutomationConfiguration {
  const { trigger } = configuration;
  const available = {
    ...configuration,
    contextAccountIds: configuration.contextAccountIds.filter((id) => options.accounts.some((account) => account.id === id)),
    repositoryIds: configuration.repositoryIds.filter((id) => options.repositories.some((repository) => repository.id === id)),
    workspaceSecretIds: configuration.workspaceSecretIds.filter((id) => options.secrets.some((secret) => secret.id === id)),
  };
  if (trigger.kind === "schedule") return available;
  const triggerAccountAvailable = options.accounts.some((account) =>
    account.id === trigger.integrationAccountId && account.provider === trigger.kind
  );
  const resourceKind = trigger.kind === "sentry" ? "sentry_project" : trigger.kind === "discord" ? "discord_channel" : "slack_channel";
  const resourceIds = new Set(options.resources
    .filter((resource) => triggerAccountAvailable && resource.integrationAccountId === trigger.integrationAccountId && resource.kind === resourceKind)
    .map((resource) => resource.externalId));
  const integrationAccountId = triggerAccountAvailable ? trigger.integrationAccountId : "";
  return {
    ...available,
    trigger: trigger.kind === "sentry"
      ? { ...trigger, integrationAccountId, projectIds: trigger.projectIds.filter((id) => resourceIds.has(id)) }
      : { ...trigger, integrationAccountId, channelIds: trigger.channelIds.filter((id) => resourceIds.has(id)) },
  };
}

// Moves `value` to `index`, keeping the order of the other items.
export function moveItem<T>(list: T[], value: T, index: number): T[] {
  const rest = list.filter((item) => item !== value);
  if (rest.length === list.length) return list;
  const target = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, target), value, ...rest.slice(target)];
}
