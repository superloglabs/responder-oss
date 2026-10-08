// Providers whose connections an automation run can use as context through
// the run-scoped context broker. GitHub is separate: it supplies repositories.
export const automationContextProviders = [
  "axiom",
  "custom_mcp",
  "datadog",
  "gcp",
  "linear",
  "sentry",
  "slack",
] as const;

export type AutomationContextProvider = typeof automationContextProviders[number];

export function isAutomationContextProvider(
  provider: string,
): provider is AutomationContextProvider {
  return (automationContextProviders as readonly string[]).includes(provider);
}
