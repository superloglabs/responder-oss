// Integrations connected from a page of their own inside Signal setup.
export const connectPages = ["otel", "grafana", "datadog", "sentry", "aws", "gcp", "railway", "linear", "posthog"] as const;
export type ConnectPage = (typeof connectPages)[number];
