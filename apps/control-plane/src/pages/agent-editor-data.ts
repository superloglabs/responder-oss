import { fetchAgent, fetchAgentOptions, fetchIntegrations, type AgentConfiguration, type AgentOptions } from "../agents-api";

const emptyOptions: AgentOptions = { accounts: [], resources: [], repositories: [], secrets: [] };

export async function loadAgentEditorData(agentId?: string) {
  const [agent, options, integrations] = await Promise.allSettled([
    agentId ? fetchAgent(agentId) : Promise.resolve(null),
    fetchAgentOptions(),
    fetchIntegrations(),
  ]);
  if (agent.status === "rejected") throw agent.reason;
  const failure = options.status === "rejected" ? options.reason : integrations.status === "rejected" ? integrations.reason : null;
  return {
    agent: agent.value,
    options: options.status === "fulfilled" ? options.value : emptyOptions,
    integrations: integrations.status === "fulfilled" ? integrations.value : [],
    settingsError: failure ? failure instanceof Error ? failure.message : "Unable to load agent settings" : null,
  };
}

export function unsupportedAgentConfiguration(configuration: AgentConfiguration | null): string | null {
  if (!configuration) return null;
  if (!["sentry_issue", "dash0_alert", "slack_channel"].includes(configuration.trigger.kind)) {
    return "This agent uses an input that this editor does not yet support. Its saved configuration is preserved; run history is still available.";
  }
  if (configuration.reporting.mode === "both") {
    return "This agent reports both in the alert thread and an output channel. This editor does not yet support combined reporting, so its saved configuration is preserved.";
  }
  return null;
}
