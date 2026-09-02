export const productIntegrationIds = [
  "aws",
  "gcp",
  "github",
  "slack",
  "sentry",
  "datadog",
  "dash0",
  "posthog",
  "axiom",
  "upstash",
  "langfuse",
  "vercel",
  "custom_mcp",
  "clickstack",
  "linear",
] as const;

export type ProductIntegrationId = (typeof productIntegrationIds)[number];

interface IntegrationDefinition {
  id: ProductIntegrationId;
  name: string;
  description: string;
  implemented: boolean;
  requiredEnvironment: string[];
}

export const integrationCatalog: IntegrationDefinition[] = [
  {
    id: "aws",
    name: "AWS",
    description: "Read-only infrastructure, telemetry, and service context.",
    implemented: true,
    requiredEnvironment: ["AWS_INTEGRATION_PRINCIPAL_ARN"],
  },
  {
    id: "gcp",
    name: "Google Cloud",
    description: "Read-only infrastructure, logs, metrics, and alert context.",
    implemented: true,
    requiredEnvironment: ["AWS_INTEGRATION_PRINCIPAL_ARN"],
  },
  {
    id: "github",
    name: "GitHub",
    description: "Repository context and optional pull request creation.",
    implemented: true,
    requiredEnvironment: [
      "GITHUB_APP_ID",
      "GITHUB_APP_SLUG",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
    ],
  },
  {
    id: "slack",
    name: "Slack",
    description: "Channel and mention triggers with investigation reporting.",
    implemented: true,
    requiredEnvironment: [
      "SLACK_CLIENT_ID",
      "SLACK_CLIENT_SECRET",
      "SLACK_SIGNING_SECRET",
    ],
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Issue triggers with event, trace, and project context.",
    implemented: true,
    requiredEnvironment: [
      "SENTRY_APP_SLUG",
      "SENTRY_CLIENT_ID",
      "SENTRY_CLIENT_SECRET",
    ],
  },
  {
    id: "datadog",
    name: "Datadog",
    description: "Monitor triggers with logs, metrics, and trace context.",
    implemented: true,
    requiredEnvironment: [],
  },
  {
    id: "dash0",
    name: "Dash0",
    description: "Failed-check triggers with logs, metrics, and trace context.",
    implemented: true,
    requiredEnvironment: [],
  },
  {
    id: "posthog",
    name: "PostHog",
    description: "Product alerts, errors, logs, replays, traces, and analytics.",
    implemented: true,
    requiredEnvironment: [],
  },
  {
    id: "axiom",
    name: "Axiom",
    description: "OAuth-connected logs, traces, metrics, and event context.",
    implemented: true,
    requiredEnvironment: [],
  },
  {
    id: "upstash",
    name: "Upstash",
    description:
      "Redis, Vector, Search, QStash, and Workflow investigation context.",
    implemented: true,
    requiredEnvironment: [],
  },
  {
    id: "langfuse",
    name: "Langfuse",
    description: "Traces, observations, scores, metrics, prompts, and alerts.",
    implemented: true,
    requiredEnvironment: [],
  },
  {
    id: "vercel",
    name: "Vercel",
    description: "Projects, deployments, domains, logs, and platform context.",
    implemented: true,
    requiredEnvironment: [
      "VERCEL_INTEGRATION_SLUG",
      "VERCEL_CLIENT_ID",
      "VERCEL_CLIENT_SECRET",
    ],
  },
  {
    id: "custom_mcp",
    name: "Custom MCP",
    description: "Connect any remote MCP server as investigation context.",
    implemented: true,
    requiredEnvironment: [],
  },
  {
    id: "clickstack",
    name: "ClickStack / HyperDX",
    description: "Logs, traces, metrics, and service context through MCP.",
    implemented: true,
    requiredEnvironment: [],
  },
  {
    id: "linear",
    name: "Linear",
    description: "Issue and project context with optional ticket creation.",
    implemented: true,
    requiredEnvironment: ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"],
  },
];

export function integrationIsConfigured(definition: IntegrationDefinition): boolean {
  return definition.requiredEnvironment.every((key) => Boolean(process.env[key]));
}

export function getIntegrationDefinition(
  id: string,
): IntegrationDefinition | undefined {
  return integrationCatalog.find((definition) => definition.id === id);
}
