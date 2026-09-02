export const providerGlyphs = {
  aws: { label: "AWS", logo: "aws" },
  axiom: { label: "Axiom", logo: "axiom" },
  clickstack: { label: "ClickStack", logo: "clickstack" },
  custom_mcp: { label: "Custom MCP", text: "MCP" },
  datadog: { label: "Datadog", logo: "datadog" },
  dash0: { label: "Dash0", text: "D0" },
  posthog: { label: "PostHog", text: "PH" },
  github: { label: "GitHub", logo: "github" },
  gcp: { label: "Google Cloud", logo: "google" },
  google: { label: "Google", logo: "google" },
  linear: { label: "Linear", logo: "linear" },
  langfuse: { label: "Langfuse", logo: "langfuse" },
  sentry: { label: "Sentry", logo: "sentry" },
  slack: { label: "Slack", logo: "slack" },
  upstash: { label: "Upstash", logo: "upstash" },
  vercel: { label: "Vercel", text: "▲" },
} as const;

export type ProviderGlyphId = keyof typeof providerGlyphs;

export function providerDisplayName(provider: string): string {
  if (provider === "clickstack") return "ClickStack / HyperDX";
  if (provider in providerGlyphs) {
    return providerGlyphs[provider as ProviderGlyphId].label;
  }
  return provider;
}
