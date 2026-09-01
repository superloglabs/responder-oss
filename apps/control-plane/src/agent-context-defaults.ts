import type { AgentOptions } from "./agents-api";

const DIRECT_CONTEXT_PROVIDERS = new Set<
  AgentOptions["accounts"][number]["provider"]
>([
  "aws",
  "sentry",
  "datadog",
  "axiom",
  "clickstack",
  "upstash",
  "langfuse",
  "custom_mcp",
  "linear",
]);

export interface DefaultAgentContext {
  contextAccountIds: string[];
  contextResourceIds: string[];
  repositoryIds: string[];
}

export interface SlackSearchContext {
  connectedAccounts: AgentOptions["accounts"];
  searchableAccounts: AgentOptions["accounts"];
  searchableChannels: AgentOptions["resources"];
  reconnectRequired: boolean;
}

export function resolveSlackSearchContext(options: AgentOptions): SlackSearchContext {
  const connectedAccounts = options.accounts.filter(
    (account) => account.provider === "slack",
  );
  const searchableAccounts = connectedAccounts.filter(
    (account) => account.slackContextAvailable,
  );
  const searchableAccountIds = new Set(
    searchableAccounts.map((account) => account.id),
  );

  return {
    connectedAccounts,
    searchableAccounts,
    searchableChannels: options.resources.filter(
      (resource) =>
        resource.kind === "slack_channel" &&
        searchableAccountIds.has(resource.integrationAccountId),
    ),
    reconnectRequired:
      connectedAccounts.length > 0 && searchableAccounts.length === 0,
  };
}

export function defaultAgentContext(options: AgentOptions): DefaultAgentContext {
  const firstSlackChannel = resolveSlackSearchContext(options).searchableChannels[0];
  const firstVercelProject = options.resources.find(
    (resource) => resource.kind === "vercel_project",
  );
  const directContextAccountIds = [
    ...new Set(
      options.accounts
        .filter((account) => DIRECT_CONTEXT_PROVIDERS.has(account.provider))
        .map((account) => account.id),
    ),
  ];
  const contextAccountIds = firstVercelProject
    ? [
        ...directContextAccountIds.slice(0, 19),
        firstVercelProject.integrationAccountId,
      ]
    : directContextAccountIds.slice(0, 20);

  return {
    contextAccountIds,
    contextResourceIds: [
      ...(firstSlackChannel ? [firstSlackChannel.id] : []),
      ...(firstVercelProject ? [firstVercelProject.id] : []),
    ],
    repositoryIds: options.repositories[0] ? [options.repositories[0].id] : [],
  };
}
