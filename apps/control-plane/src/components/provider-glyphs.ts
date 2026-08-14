export const providerGlyphs = {
  clickstack: { label: "ClickStack", text: "CS" },
  custom_mcp: { label: "Custom MCP", text: "MCP" },
  datadog: { label: "Datadog", text: "DD" },
  github: { label: "GitHub", logo: "github" },
  google: { label: "Google", logo: "google" },
  sentry: { label: "Sentry", text: "SE" },
  slack: { label: "Slack", text: "SL" },
} as const;

export type ProviderGlyphId = keyof typeof providerGlyphs;
