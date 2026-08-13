import type { AgentListItem } from "./agents-api";

export type AgentFilter = "active" | "all" | "paused";

export function integrationsForAgent(agent: AgentListItem): string[] {
  const integrations = new Set<string>();
  if (agent.trigger === "sentry_issue") integrations.add("Sentry");
  if (agent.trigger === "datadog_monitor") integrations.add("Datadog");
  if (agent.trigger === "slack_channel" || agent.trigger === "slack_mention") {
    integrations.add("Slack");
  }
  if (agent.reportConfig && agent.reportConfig.mode !== "thread") {
    integrations.add("Slack");
  }
  if (agent.repositoryCount > 0) integrations.add("GitHub");
  return [...integrations];
}

export function agentRunStatus(agent: AgentListItem): string {
  switch (agent.latestRun?.status) {
    case "pending":
      return "Queued";
    case "investigating":
      return "Investigating";
    case "resolved":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return agent.enabled ? "Ready" : "Paused";
  }
}

export function agentMatchesFilter(
  agent: AgentListItem,
  filter: AgentFilter,
): boolean {
  if (filter === "all") return true;
  return filter === "active" ? agent.enabled : !agent.enabled;
}
