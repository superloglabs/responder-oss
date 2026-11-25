// Sources whose events are alerts or other machine reports, not a person's
// request. Generic webhooks are posted by monitoring and paging tools.
const alertProviders: ReadonlySet<string> = new Set([
  "axiom",
  "betterstack",
  "errors",
  "honeycomb",
  "sentry",
  "signoz",
  "webhook",
]);

// Whether an alert started a run rather than a person. A Slack message counts
// as an alert unless a person wrote it: telemetry alerts, synthetic checks,
// and alert bots post as apps. A run an alert starts only reads the
// workspace's connections, since the alert's text is not the workspace's to
// trust.
export function automationTriggerIsAlert(trigger: Record<string, unknown>): boolean {
  const provider = trigger.provider;
  if (typeof provider !== "string") return false;
  if (alertProviders.has(provider)) return true;
  if (provider !== "slack") return false;
  const attributes = trigger.attributes;
  const authorType = attributes && typeof attributes === "object"
    ? (attributes as Record<string, unknown>).authorType
    : undefined;
  return authorType !== "person";
}
