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

export function defaultAgentContext(options: AgentOptions): DefaultAgentContext {
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
    contextResourceIds: firstVercelProject ? [firstVercelProject.id] : [],
    repositoryIds: options.repositories[0] ? [options.repositories[0].id] : [],
  };
}
