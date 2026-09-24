import type { AutomationConfiguration, AutomationOptions } from "./automations-api";

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
  const triggerAccountAvailable = options.accounts.some((account) =>
    account.id === trigger.integrationAccountId && account.provider === trigger.kind
  );
  const resourceKind = trigger.kind === "sentry" ? "sentry_project" : trigger.kind === "discord" ? "discord_channel" : "slack_channel";
  const resourceIds = new Set(options.resources
    .filter((resource) => triggerAccountAvailable && resource.integrationAccountId === trigger.integrationAccountId && resource.kind === resourceKind)
    .map((resource) => resource.externalId));
  const integrationAccountId = triggerAccountAvailable ? trigger.integrationAccountId : "";
  return {
    ...configuration,
    contextAccountIds: configuration.contextAccountIds.filter((id) => options.accounts.some((account) => account.id === id)),
    repositoryIds: configuration.repositoryIds.filter((id) => options.repositories.some((repository) => repository.id === id)),
    trigger: trigger.kind === "sentry"
      ? { ...trigger, integrationAccountId, projectIds: trigger.projectIds.filter((id) => resourceIds.has(id)) }
      : { ...trigger, integrationAccountId, channelIds: trigger.channelIds.filter((id) => resourceIds.has(id)) },
    workspaceSecretIds: configuration.workspaceSecretIds.filter((id) => options.secrets.some((secret) => secret.id === id)),
  };
}
