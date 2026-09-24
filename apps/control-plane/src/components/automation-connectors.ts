// Connectors an automation run can use. GitHub gives repository access; the
// others are served through the run-scoped context broker.
export const automationConnectorProviders = ["github", "slack", "sentry", "datadog", "custom_mcp"] as const;
export type AutomationConnectorProvider = typeof automationConnectorProviders[number];
