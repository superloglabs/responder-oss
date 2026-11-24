// Integrations connected from a page of their own inside Signal setup.
export const connectPages = ["otel", "grafana", "datadog", "axiom", "sentry", "aws", "gcp", "railway", "vercel", "linear", "jira", "posthog", "langfuse"] as const;
export type ConnectPage = (typeof connectPages)[number];
