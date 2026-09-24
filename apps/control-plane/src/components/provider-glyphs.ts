export const providerGlyphs = {
  aws: { label: "AWS", logo: "aws" },
  axiom: { label: "Axiom", logo: "axiom" },
  clickstack: { label: "ClickStack", logo: "clickstack" },
  custom_mcp: { label: "Custom MCP", text: "MCP" },
  datadog: { label: "Datadog", logo: "datadog" },
  dash0: { label: "Dash0", text: "D0" },
  discord: { label: "Discord", text: "DC" },
  posthog: { label: "PostHog", text: "PH" },
  github: { label: "GitHub", logo: "github" },
  gcp: { label: "Google Cloud", logo: "google" },
  google: { label: "Google", logo: "google" },
  grafana: { label: "Grafana", logo: "grafana" },
  linear: { label: "Linear", logo: "linear" },
  langfuse: { label: "Langfuse", logo: "langfuse" },
  sentry: { label: "Sentry", logo: "sentry" },
  scan: { label: "Scan", text: "S" },
  slack: { label: "Slack", logo: "slack" },
  supabase: { label: "Supabase", logo: "supabase" },
  upstash: { label: "Upstash", logo: "upstash" },
  vercel: { label: "Vercel", text: "▲" },
} as const;

export type ProviderGlyphId = keyof typeof providerGlyphs;

export type ContextCategory =
  | "Observability"
  | "Code & deployment"
  | "Communication & workflow"
  | "Data & infrastructure";

export const contextCategoryOrder: ContextCategory[] = [
  "Observability",
  "Code & deployment",
  "Communication & workflow",
  "Data & infrastructure",
];

export const contextCategoryDescriptions: Record<ContextCategory, string> = {
  Observability: "Errors, logs, traces, and service health",
  "Code & deployment": "Source code, releases, and runtime changes",
  "Communication & workflow": "Team conversations and incident follow-up",
  "Data & infrastructure": "Cloud resources, databases, and custom tools",
};

export const contextProviderMetadata: Record<
  Exclude<ProviderGlyphId, "discord" | "google" | "scan">,
  { category: ContextCategory; searchTerms: string }
> = {
  sentry: { category: "Observability", searchTerms: "errors exceptions monitoring" },
  datadog: { category: "Observability", searchTerms: "apm logs monitors" },
  dash0: { category: "Observability", searchTerms: "logs metrics traces checks alerts" },
  posthog: { category: "Observability", searchTerms: "analytics errors logs traces replays alerts" },
  grafana: { category: "Observability", searchTerms: "dashboards prometheus loki tempo alerts metrics logs traces" },
  axiom: { category: "Observability", searchTerms: "logs traces metrics monitors" },
  clickstack: { category: "Observability", searchTerms: "hyperdx logs traces" },
  langfuse: { category: "Observability", searchTerms: "llm traces prompts projects" },
  github: { category: "Code & deployment", searchTerms: "repositories code pull requests" },
  vercel: { category: "Code & deployment", searchTerms: "deployments projects hosting" },
  slack: { category: "Communication & workflow", searchTerms: "channels messages chat" },
  linear: { category: "Communication & workflow", searchTerms: "issues projects tickets" },
  aws: { category: "Data & infrastructure", searchTerms: "cloud accounts iam services" },
  gcp: { category: "Data & infrastructure", searchTerms: "google cloud projects logs metrics assets" },
  upstash: { category: "Data & infrastructure", searchTerms: "redis vector qstash workflow" },
  supabase: { category: "Data & infrastructure", searchTerms: "postgres database sql logs" },
  custom_mcp: { category: "Data & infrastructure", searchTerms: "custom tools server mcp" },
};

export function providerDisplayName(provider: string): string {
  if (provider === "clickstack") return "ClickStack / HyperDX";
  if (provider in providerGlyphs) {
    return providerGlyphs[provider as ProviderGlyphId].label;
  }
  return provider;
}
