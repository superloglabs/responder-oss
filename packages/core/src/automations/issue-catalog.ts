// Alerts from these sources often repeat, so runs of an automation they
// trigger share a catalog of the issues it has reported.
export const issueCatalogTriggerKinds: ReadonlySet<string> = new Set([
  "axiom",
  "betterstack",
  "honeycomb",
  "sentry",
  "signoz",
]);

// An automation keeps a catalog when an alert can start it and it reports to
// Slack.
export function automationUsesIssueCatalog(configuration: {
  notifications: readonly unknown[];
  triggers: ReadonlyArray<{ kind: string }>;
}): boolean {
  return configuration.notifications.length > 0 &&
    configuration.triggers.some((trigger) => issueCatalogTriggerKinds.has(trigger.kind));
}
