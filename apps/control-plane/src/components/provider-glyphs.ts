export const providerGlyphs = {
  clickstack: { label: "ClickStack", text: "CS" },
  custom_mcp: { label: "Custom MCP", text: "MCP" },
  datadog: { label: "Datadog", text: "DD" },
  github: { label: "GitHub", text: "GH" },
  google: { label: "Google", text: "GO" },
  sentry: { label: "Sentry", text: "SE" },
  slack: { label: "Slack", text: "SL" },
  upstash: { label: "Upstash", text: "UP" },
} as const;

export type ProviderGlyphId = keyof typeof providerGlyphs;
