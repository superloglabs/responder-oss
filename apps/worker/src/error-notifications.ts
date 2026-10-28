import { getErrorNotificationSettings, processPendingErrorNotifications } from "@responder/core/db/error-notifications";
import type { errorNotificationDeliveries } from "@responder/core/db/schema";
import { pausedTelemetryNotificationOrganizations } from "@responder/core/db/telemetry-notification-pauses";
import { listTelemetryAlertSlackChannels } from "@responder/core/db/telemetry-alerts";
import { organizationHasCapability } from "@responder/core/db/organization-capabilities";
import { responderErrorIssueUrl } from "@responder/core/responder-urls";
import { errorNotificationTargetKey, matchesErrorNotification, type ErrorNotificationSnapshot } from "@responder/core/telemetry/error-notifications";
import { postAutomationNotification } from "./automation-notifications.js";

type Delivery = typeof errorNotificationDeliveries.$inferSelect;
export function errorNotificationMessage(snapshot: ErrorNotificationSnapshot, url: string) {
  const heading = snapshot.transition === "new" ? "New error" : "Error returned";
  const title = snapshot.title.replace(/[\r\n]/gu, " ").slice(0, 250);
  const text = `${heading}: ${title}\n\n${snapshot.transition === "new" ? "This error was seen for the first time." : "This error was resolved and has occurred again."}\nService: ${snapshot.service ?? "unknown"}\nType: ${snapshot.exceptionType}\nSeen at: ${snapshot.seenAt}\n\nView error: ${url}`;
  return { subject: `${heading}: ${title}`, text };
}
const defaults = {
  post: postAutomationNotification,
  channels: listTelemetryAlertSlackChannels,
  settings: getErrorNotificationSettings, paused: pausedTelemetryNotificationOrganizations,
  hasCapability: organizationHasCapability,
  origin: () => process.env.RESPONDER_APP_URL ?? process.env.BETTER_AUTH_URL,
};
// Returns false for a destination that is no longer authorized. Sending is
// idempotent per persisted delivery; each destination retries independently.
export async function deliverErrorNotification(delivery: Delivery, deps = defaults): Promise<boolean> {
  if ((await deps.paused()).has(delivery.organizationId) || !(await deps.hasCapability(delivery.organizationId, "telemetry"))) return false;
  const settings = await deps.settings(delivery.organizationId);
  if (!matchesErrorNotification(settings) || !settings.targets.some((target) => errorNotificationTargetKey(target) === delivery.targetKey)) return false;
  const origin = deps.origin();
  if (!origin) throw new Error("Application URL is not configured");
  const url = responderErrorIssueUrl(delivery.issueId, origin);
  const message = errorNotificationMessage(delivery.snapshot, url);
  const target = delivery.target;
  const channel = (await deps.channels(delivery.organizationId)).find((channel) => channel.integrationAccountId === target.integrationAccountId && channel.channelId === target.channelId);
  if (!channel) return false;
  // Escape Slack control characters and markdown from untrusted error text.
  const plain = (value: string) => value.replace(/[&<>]/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]!).replace(/([\\`*_[\]])/gu, "\\$1");
  const [result] = await deps.post({
    organizationId: delivery.organizationId,
    notifications: [{ kind: "slack", integrationAccountId: target.integrationAccountId, channelId: target.channelId }],
    seed: `error-notice/${delivery.id}`, text: message.subject,
    markdown: `${plain(message.text.slice(0, message.text.indexOf("\n\nView error:")))}\n\n[View error](${url})`,
    unfurlLinks: false,
  });
  if (!result || "error" in result || !result.timestamp) throw new Error("Slack notification failed");
  return true;
}

export async function processErrorNotifications(): Promise<void> {
  await processPendingErrorNotifications(deliverErrorNotification);
}
