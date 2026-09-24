import type { AgentOptions, SlackThreadModeConfiguration } from "./agents-api";

// Saved tag mode settings can reference accounts, resources, repositories, or
// secrets that were removed since, or repeat an ID. The page cannot show them,
// and the server rejects them, so keep each ID the current options still offer
// once.
export function availableTagModeConfiguration(
  configuration: SlackThreadModeConfiguration,
  options: AgentOptions,
): SlackThreadModeConfiguration {
  const available = (ids: string[], items: { id: string }[]) =>
    [...new Set(ids)].filter((id) => items.some((item) => item.id === id));
  return {
    ...configuration,
    contextAccountIds: available(configuration.contextAccountIds, options.accounts),
    contextResourceIds: available(configuration.contextResourceIds, options.resources),
    repositoryIds: available(configuration.repositoryIds, options.repositories),
    secretIds: available(configuration.secretIds, options.secrets),
  };
}
