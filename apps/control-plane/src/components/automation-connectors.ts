// Connectors an automation run can use. GitHub gives repository access; the
// others are served through the run-scoped context broker.
export const automationConnectorProviders = ["github", "slack", "sentry", "axiom", "signoz", "honeycomb", "betterstack", "datadog", "grafana", "aws", "gcp", "cloudflare", "railway", "vercel", "linear", "custom_mcp"] as const;
export type AutomationConnectorProvider = typeof automationConnectorProviders[number];
