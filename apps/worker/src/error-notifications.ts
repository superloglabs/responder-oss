import { errorNotificationActions } from "@responder/core/telemetry/error-notification-actions";
import {
  type ErrorNotificationFollowup, getErrorNotificationSettings, processPendingErrorNotificationFollowups, processPendingErrorNotifications,
} from "@responder/core/db/error-notifications";
import { SlackApiError } from "@responder/core/integrations/slack";
import type { errorNotificationDeliveries } from "@responder/core/db/schema";
import { pausedTelemetryNotificationOrganizations } from "@responder/core/db/telemetry-notification-pauses";
import { listTelemetryAlertSlackChannels } from "@responder/core/db/telemetry-alerts";
import { organizationHasCapability } from "@responder/core/db/organization-capabilities";
import { responderErrorIssueUrl } from "@responder/core/responder-urls";
import { errorNotificationTargetKey, matchesErrorNotification, type ErrorNotificationSnapshot } from "@responder/core/telemetry/error-notifications";
import {
  type ErrorIssueActivity, type ErrorIssueActor, type ErrorIssueClaim, type ErrorIssueStatus, errorIssueActorName,
} from "@responder/core/telemetry/error-issues";
import { postAutomationNotification, updateSlackNotification } from "./automation-notifications.js";

type Delivery = typeof errorNotificationDeliveries.$inferSelect;
export function errorNotificationMessage(snapshot: ErrorNotificationSnapshot, url: string) {
  const heading = snapshot.transition === "new" ? "New error" : "Error returned";
  const title = snapshot.title.replace(/[\r\n]/gu, " ").slice(0, 250);
  const text = `${heading}: ${title}\n\n${snapshot.transition === "new" ? "This error was seen for the first time." : "This error was resolved and has occurred again."}\nService: ${snapshot.service ?? "unknown"}\nType: ${snapshot.exceptionType}\nSeen at: ${snapshot.seenAt}\n\nView error: ${url}`;
  return { subject: `${heading}: ${title}`, text };
}
const compact = (value: string, limit: number) => {
  const line = value.replace(/[\r\n]/gu, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

// The issue as a notification shows it after it was posted.
export type ErrorNotificationState = {
  claim: ErrorIssueClaim | null;
  status: ErrorIssueStatus;
  // Who set the status, when known.
  statusActor: ErrorIssueActor | null;
};

function stateLine(state: ErrorNotificationState): string | null {
  const by = state.statusActor ? ` by ${errorIssueActorName(state.statusActor)}` : "";
  if (state.status === "resolved") return `✅ Resolved${by}`;
  if (state.status === "silenced") return `🔕 Silenced${by}`;
  return state.claim ? `🛠 Claimed by ${errorIssueActorName(state.claim)}` : null;
}

// Structured text keeps error content literal, including mentions and code fences.
export function errorNotificationBlocks(snapshot: ErrorNotificationSnapshot, url: string, state?: ErrorNotificationState) {
  const exceptionType = compact(snapshot.exceptionType, 200) || "Error";
  const prefix = `${snapshot.exceptionType}:`;
  const message = snapshot.title.startsWith(prefix) ? snapshot.title.slice(prefix.length).trim() : snapshot.title;
  const timestamp = Math.floor(Date.parse(snapshot.seenAt) / 1000);
  const regressed = snapshot.transition === "regressed";
  const marker = state?.status === "resolved" ? "✅ " : state?.status === "silenced" ? "🔕 " : regressed ? "🟠 " : "🔴 ";
  const line = state ? stateLine(state) : null;
  return [
    { type: "header", text: { type: "plain_text", text: regressed ? "Error recurrence" : "New error", emoji: true } },
    {
      type: "rich_text",
      elements: [
        { type: "rich_text_section", elements: [
          { type: "text", text: marker },
          { type: "link", url, text: exceptionType, style: { bold: true } },
        ] },
      ],
    },
    {
      type: "rich_text",
      elements: [
        { type: "rich_text_preformatted", elements: [
          { type: "text", text: compact(message || snapshot.title, 1500) || exceptionType },
        ] },
      ],
    },
    {
      type: "context",
      elements: [
        { type: "plain_text", text: `Service: ${compact(snapshot.service ?? "unknown", 200) || "unknown"}`, emoji: true },
        ...(Number.isFinite(timestamp) ? [{
          type: "mrkdwn",
          text: `${regressed ? "Seen again" : "First seen"}: <!date^${timestamp}^{date_short_pretty} at {time}|${new Date(timestamp * 1000).toISOString()}>`,
        }] : []),
      ],
    },
    ...(line ? [{ type: "context", elements: [{ type: "plain_text", text: compact(line, 300), emoji: true }] }] : []),
  ];
}

function activityVerb(activity: ErrorIssueActivity): string {
  if (activity.type === "claimed") return "claimed this error";
  if (activity.type === "released") return "released this error";
  if (activity.type === "status") {
    return { open: "reopened this error", resolved: "resolved this error", silenced: "silenced this error" }[activity.status ?? "open"];
  }
  return activity.pullRequestUrl ? "linked a pull request" : "posted an update";
}

// A pull request URL as `owner/repo#number` when it has that shape.
function pullRequestLabel(url: string): string {
  const match = /^https:\/\/[^/]+\/(.+?)\/(?:-\/)?(?:pull|merge_requests)\/(\d+)/u.exec(url);
  return match ? `${match[1]}#${match[2]}` : url;
}

// A thread reply for an issue's activity. Agent-written text stays literal,
// so it cannot mention people or channels.
export function errorNotificationFollowupBlocks(activity: ErrorIssueActivity) {
  const message = activity.message?.trim();
  return [{
    type: "rich_text",
    elements: [
      { type: "rich_text_section", elements: [
        activity.actor.slackUserId
          ? { type: "user", user_id: activity.actor.slackUserId }
          : { type: "text", text: compact(errorIssueActorName(activity.actor), 300), style: { bold: true } },
        { type: "text", text: ` ${activityVerb(activity)}` },
        ...(activity.pullRequestUrl ? [
          { type: "text", text: ": " },
          { type: "link", url: activity.pullRequestUrl, text: compact(pullRequestLabel(activity.pullRequestUrl), 200) },
        ] : []),
      ] },
      ...(message ? [{ type: "rich_text_quote", elements: [
        { type: "text", text: message.length > 2900 ? `${message.slice(0, 2899)}…` : message },
      ] }] : []),
    ],
  }];
}
const defaults = {
  post: postAutomationNotification,
  channels: listTelemetryAlertSlackChannels,
  settings: getErrorNotificationSettings, paused: pausedTelemetryNotificationOrganizations,
  hasCapability: organizationHasCapability,
  origin: () => process.env.RESPONDER_APP_URL ?? process.env.BETTER_AUTH_URL,
};
// Whether the workspace still sends to a delivery's destination.
async function destinationAvailable(delivery: Delivery, deps: Pick<typeof defaults, "channels" | "hasCapability" | "paused" | "settings">): Promise<boolean> {
  if ((await deps.paused()).has(delivery.organizationId) || !(await deps.hasCapability(delivery.organizationId, "telemetry"))) return false;
  const settings = await deps.settings(delivery.organizationId);
  if (!matchesErrorNotification(settings) || !settings.targets.some((target) => errorNotificationTargetKey(target) === delivery.targetKey)) return false;
  const target = delivery.target;
  return (await deps.channels(delivery.organizationId)).some((channel) => channel.integrationAccountId === target.integrationAccountId && channel.channelId === target.channelId);
}

// Returns the posted message's timestamp, or null for a destination that is
// no longer authorized. Sending is idempotent per persisted delivery; each
// destination retries independently.
export async function deliverErrorNotification(delivery: Delivery, deps = defaults): Promise<string | null> {
  if (!(await destinationAvailable(delivery, deps))) return null;
  const origin = deps.origin();
  if (!origin) throw new Error("Application URL is not configured");
  const url = responderErrorIssueUrl(delivery.issueId, origin);
  const message = errorNotificationMessage(delivery.snapshot, url);
  const target = delivery.target;
  const [result] = await deps.post({
    organizationId: delivery.organizationId,
    notifications: [{ kind: "slack", integrationAccountId: target.integrationAccountId, channelId: target.channelId }],
    seed: `error-notice/${delivery.id}`, text: message.subject,
    markdown: message.text, blocks: errorNotificationBlocks(delivery.snapshot, url),
    buttonsBlock: errorNotificationActions({ deliveryId: delivery.id, url, context: message.text }),
    unfurlLinks: false,
  });
  if (!result || "error" in result || !result.timestamp) throw new Error("Slack notification failed");
  return result.timestamp;
}

// Slack refuses to edit a message that was deleted or is too old to edit.
const uneditable = new Set(["cant_update_message", "edit_window_closed", "message_not_found"]);

// Brings the notification up to date with the issue's status and claim, then
// replies in its thread. Returns false for a destination that is no longer
// authorized. A retry repeats the edit and Slack deduplicates the reply.
export async function deliverErrorNotificationFollowup(
  followup: ErrorNotificationFollowup,
  deps: typeof defaults & { update: typeof updateSlackNotification } = { ...defaults, update: updateSlackNotification },
): Promise<boolean> {
  const { activity, delivery, issue } = followup;
  if (!(await destinationAvailable(delivery, deps))) return false;
  const origin = deps.origin();
  if (!origin) throw new Error("Application URL is not configured");
  const url = responderErrorIssueUrl(delivery.issueId, origin);
  const message = errorNotificationMessage(delivery.snapshot, url);
  const target = delivery.target;
  try {
    await deps.update({
      organizationId: delivery.organizationId, integrationAccountId: target.integrationAccountId, channelId: target.channelId,
      timestamp: delivery.messageTimestamp, text: message.subject,
      blocks: [
        ...errorNotificationBlocks(delivery.snapshot, url, issue),
        ...(issue.status === "open" ? [errorNotificationActions({ deliveryId: delivery.id, url, context: message.text })] : []),
      ],
    });
  } catch (error) {
    if (!(error instanceof SlackApiError) || !uneditable.has(error.code)) throw error;
  }
  const text = `${errorIssueActorName(activity.actor)} ${activityVerb(activity)}`;
  const [result] = await deps.post({
    organizationId: delivery.organizationId,
    notifications: [{ kind: "slack", integrationAccountId: target.integrationAccountId, channelId: target.channelId }],
    seed: `error-followup/${followup.id}`, text, markdown: text,
    blocks: errorNotificationFollowupBlocks(activity),
    threadTimestamp: delivery.messageTimestamp,
    unfurlLinks: false,
  });
  if (!result || "error" in result || !result.timestamp) throw new Error("Slack follow-up failed");
  return true;
}

export async function processErrorNotifications(): Promise<void> {
  await processPendingErrorNotifications(deliverErrorNotification);
  await processPendingErrorNotificationFollowups(deliverErrorNotificationFollowup);
}
