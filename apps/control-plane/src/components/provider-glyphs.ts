export const providerGlyphs = {
  clickstack: { label: "ClickStack", logo: "clickstack" },
  custom_mcp: { label: "Custom MCP", text: "MCP" },
  datadog: { label: "Datadog", logo: "datadog" },
  github: { label: "GitHub", logo: "github" },
  google: { label: "Google", logo: "google" },
  linear: { label: "Linear", logo: "linear" },
  sentry: { label: "Sentry", logo: "sentry" },
  slack: { label: "Slack", logo: "slack" },
  vercel: { label: "Vercel", text: "▲" },
} as const;

export type ProviderGlyphId = keyof typeof providerGlyphs;
