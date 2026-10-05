import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { captureAnalyticsEvent } from "@responder/core/analytics";
import { decryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import { findAgentsForSlackEvent } from "../../../../packages/core/src/db/agents.js";
import {
  automationButtonIndex,
  pressedAutomationButtonBlocks,
} from "../../../../packages/core/src/automations/slack-buttons.js";
import {
  findAutomationsForSlackEvent,
  findSlackThreadAutomationRun,
  getAutomationRunSlackButtons,
  recordSlackMessageAuthor,
} from "../../../../packages/core/src/db/automations.js";
import {
  claimSlackDirectMessageWelcome,
  getConnectedIntegrationAccountCredential,
  getSlackChannelConnection,
  listConnectedSlackAccountsForTeam,
  markSlackDirectMessageWelcomeSent,
  releaseSlackDirectMessageWelcome,
} from "../../../../packages/core/src/db/integrations.js";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import {
  getInvestigationForSlackAction,
  findSlackIssueThread,
  recordInvestigationSlackMessage,
  recordInvestigationSlackSource,
  removeInvestigationSlackReply,
  setInvestigationSlackReaction,
} from "../../../../packages/core/src/db/investigations.js";
import { getIssueForSlackAction } from "../../../../packages/core/src/db/issues.js";
import {
  IssuePullRequestError,
  registerIssuePullRequestSlackMessage,
} from "../../../../packages/core/src/db/pull-requests.js";
import { renderIssueFixPrompt } from "../../../../packages/core/src/investigations/report.js";
import {
  addSlackReaction,
  postSlackEphemeralMessage,
  postSlackMessage,
  setSlackThreadStatus,
} from "../../../../packages/core/src/integrations/slack.js";
import {
  failInvestigationSlackCard,
  investigationIdFromFeedbackBlockId,
  slackErrorLogFields,
  slackInvestigationCard,
} from "../../../../packages/core/src/integrations/slack-live-card.js";
import { reconcileCompletedInvestigationSlackCard } from "../../../../packages/core/src/integrations/slack-delivery.js";
import { slackAssistantAttribute } from "../../../../packages/core/src/integrations/slack-assistant.js";
import {
  parseSlackRemediationActionValue,
  refreshIssuePullRequestSlackMessages,
  slackIssuePullRequestMessage,
  type SlackIssuePullRequestCard,
} from "../../../../packages/core/src/integrations/slack-remediations.js";
import { startSlackIssueRemediation } from "../issues/remediation.js";
import {
  queueInvestigation,
  queueSlackThreadInvestigation,
} from "../investigations/queue.js";
import {
  queueAutomationRun,
  queueAutomationRunReply,
} from "../automations/queue.js";

const slackUrlVerificationSchema = z.object({
  type: z.literal("url_verification"),
  challenge: z.string().min(1),
});

const slackMessageSchema = z.object({
  type: z.enum(["message", "app_mention"]),
  channel: z.string().min(1),
  // "im" for a direct message to the app.
  channel_type: z.string().optional(),
  ts: z.string().min(1),
  thread_ts: z.string().optional(),
  user: z.string().optional(),
  user_profile: z
    .object({
      display_name: z.string().optional(),
      real_name: z.string().optional(),
    })
    .passthrough()
    .optional(),
  app_id: z.string().optional(),
  bot_id: z.string().optional(),
  username: z.string().optional(),
  text: z.string().optional().default(""),
  subtype: z.string().optional(),
  bot_profile: z
    .object({
      app_id: z.string().optional(),
      id: z.string().optional(),
      name: z.string().optional(),
    })
    .passthrough()
    .optional(),
  blocks: z.array(z.unknown()).optional(),
  files: z
    .array(
      z.object({
        name: z.string().optional(),
        title: z.string().optional(),
      }).passthrough(),
    )
    .optional(),
  attachments: z
    .array(
      z.object({
        fallback: z.string().optional(),
        title: z.string().optional(),
        text: z.string().optional(),
        fields: z
          .array(
            z.object({
              title: z.string().optional(),
              value: z.string().optional(),
            }),
          )
          .optional(),
      }).passthrough(),
    )
    .optional(),
}).passthrough();

const slackEventCallbackSchema = z.object({
  type: z.literal("event_callback"),
  team_id: z.string().min(1),
  event_id: z.string().min(1),
  event: slackMessageSchema,
});
// Slack sends this each time a person opens one of the app's tabs.
const slackAppHomeOpenedSchema = z.object({
  type: z.literal("event_callback"),
  team_id: z.string().min(1),
  event: z.object({
    type: z.literal("app_home_opened"),
    channel: z.string().min(1),
    tab: z.string(),
    user: z.string().min(1),
  }),
});
const slackCredentialsSchema = z.object({
  accessToken: z.string().min(1),
});
const investigationStartResponseSchema = z.object({
  duplicate: z.boolean(),
  investigationId: z.uuid(),
});
const investigationFeedbackSchema = z.enum(["positive", "negative"]);
const slackBlockActionsSchema = z.object({
  type: z.literal("block_actions"),
  team: z.object({ id: z.string().min(1) }),
  channel: z.object({ id: z.string().min(1) }),
  user: z.object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
  }),
  response_url: z.string().url(),
  message: z
    .object({
      blocks: z.array(z.unknown()).optional(),
      text: z.string().optional(),
      ts: z.string().min(1).optional(),
      thread_ts: z.string().min(1).optional(),
    })
    .optional(),
  actions: z.array(
    z.object({
      action_id: z.string().min(1),
      block_id: z.string().min(1).optional(),
      value: z.string().optional(),
    }),
  ),
});

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function verifySlackSignature(input: {
  rawBody: string;
  signature: string | undefined;
  timestamp: string | undefined;
  signingSecret?: string;
  now?: number;
}): boolean {
  const signingSecret = input.signingSecret ?? process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret || !input.signature || !input.timestamp) return false;

  const timestamp = Number(input.timestamp);
  const now = input.now ?? Date.now();
  if (
    !Number.isFinite(timestamp) ||
    Math.abs(Math.floor(now / 1_000) - timestamp) > 5 * 60
  ) {
    return false;
  }

  const digest = createHmac("sha256", signingSecret)
    .update(`v0:${input.timestamp}:${input.rawBody}`)
    .digest("hex");
  return safeEqual(`v0=${digest}`, input.signature);
}

function slackBlockStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(slackBlockStrings);
  if (!value || typeof value !== "object") return [];

  return Object.entries(value).flatMap(([key, child]) =>
    ["text", "title", "url", "value", "fallback", "alt_text"].includes(key)
      ? slackBlockStrings(child)
      : typeof child === "object" && child !== null
        ? slackBlockStrings(child)
        : [],
  );
}

// The message's text, attachments, and block text; empty when it has none.
function slackMessageContent(
  event: z.infer<typeof slackMessageSchema>,
): string {
  const attachmentText = event.attachments
    ?.flatMap((attachment) => [
      attachment.fallback,
      attachment.title,
      attachment.text,
      ...(attachment.fields ?? []).flatMap((field) => [
        field.title,
        field.value,
      ]),
    ])
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");
  const blockText = slackBlockStrings(event.blocks ?? [])
    .filter((value) => value.trim())
    .join("\n");

  return [event.text, attachmentText, blockText]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n\n")
    .slice(0, 100_000);
}

export function slackMessageBody(
  event: z.infer<typeof slackMessageSchema>,
): string {
  return slackMessageContent(event) ||
    "A new alert was posted in the configured Slack channel.";
}

export function isSupportedSlackMessageSubtype(
  subtype: string | undefined,
): boolean {
  return (
    !subtype || subtype === "bot_message" || subtype === "thread_broadcast"
  );
}

function slackMessageTitle(body: string): string {
  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return (firstLine ?? "Slack channel alert").slice(0, 500);
}

export interface SlackEventAuthor {
  // The app ID for an app when Slack sends one, else its bot ID; the user ID
  // for a person.
  id: string;
  // Every user, bot, and app ID Slack sent for the sender.
  ids: string[];
  kind: "app" | "person";
  // Absent for a person whose profile Slack did not send.
  name?: string;
}

// Who posted the message. A message without a bot or app is a person's.
export function slackEventAuthor(
  event: Pick<z.infer<typeof slackMessageSchema>, "app_id" | "bot_id" | "bot_profile" | "user" | "user_profile" | "username">,
): SlackEventAuthor | null {
  const ids = [
    ...new Set([event.user, event.bot_id, event.bot_profile?.id, event.app_id, event.bot_profile?.app_id]
      .filter((value): value is string => Boolean(value))),
  ];
  if (event.user && !event.bot_id && !event.app_id && !event.bot_profile) {
    const name = event.user_profile?.display_name?.trim() || event.user_profile?.real_name?.trim();
    return { id: event.user, ids, kind: "person", ...(name ? { name } : {}) };
  }
  const id = event.app_id || event.bot_profile?.app_id || event.bot_id || event.bot_profile?.id || event.user;
  if (!id) return null;
  const name = event.bot_profile?.name?.trim() || event.username?.trim();
  return { id, ids, kind: "app", ...(name ? { name } : {}) };
}

function slackMessageAuthor(
  event: z.infer<typeof slackMessageSchema>,
): string {
  return event.bot_profile?.name?.trim() ||
    event.username?.trim() ||
    (event.user ? "Customer" : "Slack app");
}

export function isDatadogRecoveryMessage(body: string): boolean {
  return (
    /^Recovered:/i.test(slackMessageTitle(body)) &&
    /https:\/\/[^>\s]*datadoghq\.(?:com|eu)\//i.test(body)
  );
}

export function isPostHogInactiveMessage(body: string): boolean {
  return /\b(?:has resolved|has recovered|was resolved|was auto-disabled|couldn['’]t evaluate)\b/iu.test(
    slackMessageTitle(body),
  );
}

export function isResolvedSlackAlert(body: string): boolean {
  return /^(?:✅|:white_check_mark:)\s*/iu.test(slackMessageTitle(body));
}

export function isSlackErrorRecap(body: string): boolean {
  const title = slackMessageTitle(body)
    .replace(/^\*+|\*+$/gu, "")
    .trim();
  return /^(?:(?::bar_chart:|📊)\s*)?error\s+recap\s*[·•—-]\s*last\s+\d+\s*(?:m|h|d|hours?|days?)$/iu.test(
    title,
  );
}

export function isSlackIssueResolutionMessage(body: string): boolean {
  return /\b[A-Z][A-Z0-9_-]*-\d+\s+was resolved\b/iu.test(body);
}

export function isSentryIssueAlert(
  body: string,
  subtype?: string,
): boolean {
  const title = slackMessageTitle(body);
  if (/^\[[^\]\r\n]+\]\s+\S/u.test(title)) return true;

  return (
    subtype === "thread_broadcast" &&
    /^[A-Z][A-Z0-9_-]*-\d+\s+\S/u.test(title) &&
    !isSlackIssueResolutionMessage(body) &&
    /https:\/\/[^>\s]*sentry\.io\/(?:organizations\/[^/\s>]+\/)?issues\//iu.test(
      body,
    )
  );
}

type SlackAlertProvider = "app" | "aws" | "datadog" | "posthog" | "sentry";

export type SlackAwsAlarm = {
  alarmName?: string;
  consoleUrl?: string;
  region?: string;
  state: "ALARM" | "INSUFFICIENT_DATA" | "OK";
};

function slackMessageUrls(body: string): string[] {
  return body.match(/https:\/\/[^\s>|)]+/giu) ?? [];
}

function cloudWatchAlarmUrl(body: string): URL | null {
  for (const candidate of slackMessageUrls(body)) {
    try {
      const url = new URL(candidate);
      if (
        /^(?:[a-z0-9-]+\.)?console\.aws\.amazon\.com$/iu.test(url.hostname) &&
        url.pathname === "/cloudwatch/home" &&
        /alarmsV2:alarm\//iu.test(url.hash)
      ) {
        return url;
      }
    } catch {
      // Ignore malformed URLs extracted from message formatting.
    }
  }
  return null;
}

function alarmNameFromUrl(url: URL): string | undefined {
  try {
    const hash = decodeURIComponent(url.hash);
    const marker = "alarmsV2:alarm/";
    const markerIndex = hash.toLowerCase().indexOf(marker.toLowerCase());
    if (markerIndex === -1) return undefined;
    const alarmName = hash.slice(markerIndex + marker.length).trim();
    return alarmName || undefined;
  } catch {
    return undefined;
  }
}

export function slackAwsAlarm(input: {
  body: string;
  senderName?: string;
}): SlackAwsAlarm | null {
  const senderName = input.senderName?.trim() ?? "";
  const isAwsSender = /\b(?:amazon\s+q|aws)\b/iu.test(senderName);
  const consoleUrl = cloudWatchAlarmUrl(input.body);
  if (!isAwsSender && !consoleUrl) return null;

  const stateMatch = input.body.match(
    /\b(?:changed state to|state:)\s*(ALARM|OK|INSUFFICIENT_DATA)\b/iu,
  );
  const criticalAlarm =
    /^(?:\s*(?:🚨|:rotating_light:)\s*)?\**CRITICAL\b/imu.test(input.body) &&
    (/\bAlarm Details\b/iu.test(input.body) || consoleUrl !== null);
  const state = stateMatch?.[1]?.toUpperCase() ??
    (criticalAlarm ? "ALARM" : undefined);
  if (state !== "ALARM" && state !== "OK" && state !== "INSUFFICIENT_DATA") {
    return null;
  }

  const alarmNameMatch = input.body.match(
    /\bThe alarm\s+(.+?)\s+changed state to\s+(?:ALARM|OK|INSUFFICIENT_DATA)\b/iu,
  );
  const region = consoleUrl?.searchParams.get("region") ??
    consoleUrl?.hostname.match(/^([a-z0-9-]+)\.console\.aws\.amazon\.com$/iu)?.[1];
  const alarmName = alarmNameMatch?.[1]?.trim() ||
    (consoleUrl ? alarmNameFromUrl(consoleUrl) : undefined);

  return {
    ...(alarmName ? { alarmName } : {}),
    ...(consoleUrl ? { consoleUrl: consoleUrl.toString() } : {}),
    ...(region ? { region } : {}),
    state,
  };
}

export function shouldIgnoreResolvedSlackAlert(
  alertProvider: SlackAlertProvider,
  body: string,
  senderName?: string,
): boolean {
  if (alertProvider === "aws") {
    return slackAwsAlarm({ body, senderName })?.state !== "ALARM";
  }
  if (alertProvider === "posthog") return isPostHogInactiveMessage(body);
  return (
    alertProvider === "app" &&
    (isResolvedSlackAlert(body) ||
      (/^slack$/iu.test(senderName?.trim() ?? "") &&
        isSlackIssueResolutionMessage(body)))
  );
}

export function logAcceptedSlackAppAlert(input: {
  botAppId: string | null;
  botId: string | null;
  channelId: string;
  eventId: string;
  subtype: string | null;
  teamId: string;
  timestamp: string;
}): void {
  console.info(
    JSON.stringify({
      ...input,
      event: "slack_app_alert_accepted",
    }),
  );
}

export function slackAlertProvider(input: {
  body: string;
  botAppId?: string;
  botId?: string;
  botName?: string;
  subtype?: string;
  username?: string;
}): SlackAlertProvider | null {
  const isAppMessage = Boolean(input.botAppId || input.botId);
  const isThreadBroadcast = input.subtype === "thread_broadcast";
  if (!isAppMessage && !isThreadBroadcast) return null;

  const senderName = input.botName?.trim() || input.username?.trim();
  if (isAppMessage && slackAwsAlarm({ body: input.body, senderName })) {
    return "aws";
  }
  if (senderName) {
    if (/\bdatadog\b/i.test(senderName)) return "datadog";
    if (/\bposthog\b/i.test(senderName)) return "posthog";
    if (/\bsentry\b/i.test(senderName)) return "sentry";
    return /\balert\b/i.test(input.body) ? "app" : null;
  }

  if (/https:\/\/[^>\s]*datadoghq\.(?:com|eu)\//i.test(input.body)) {
    return "datadog";
  }
  if (/https:\/\/[^>\s]*posthog\.com\//i.test(input.body)) {
    return "posthog";
  }
  if (/https:\/\/[^>\s]*sentry\.io\//i.test(input.body)) {
    return "sentry";
  }
  return /\balert\b/i.test(input.body) ? "app" : null;
}

export type SlackAlertIgnoreReason =
  | "datadog_recovery"
  | "error_recap"
  | "resolved_alert"
  | "unsupported_sentry_message";

export function slackAlertIgnoreReason(input: {
  alertProvider: SlackAlertProvider;
  body: string;
  senderName?: string;
  subtype?: string;
}): SlackAlertIgnoreReason | null {
  if (
    shouldIgnoreResolvedSlackAlert(
      input.alertProvider,
      input.body,
      input.senderName,
    )
  ) {
    return "resolved_alert";
  }
  if (input.alertProvider === "app" && isSlackErrorRecap(input.body)) {
    return "error_recap";
  }
  if (
    input.alertProvider === "sentry" &&
    !isSentryIssueAlert(input.body, input.subtype)
  ) {
    return "unsupported_sentry_message";
  }
  if (
    input.alertProvider === "datadog" &&
    isDatadogRecoveryMessage(input.body)
  ) {
    return "datadog_recovery";
  }
  return null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function forwardSlackEvent(input: {
  agentId: string;
  alertProvider: SlackAlertProvider | null;
  assistant?: boolean;
  awsAlarm: SlackAwsAlarm | null;
  body: string;
  channelId: string;
  eventId: string;
  integrationAccountId: string;
  teamId: string;
  threadTimestamp: string;
  timestamp: string;
  threadMode?: boolean;
  userId?: string;
  userName?: string;
}) {
  const request = {
    agentId: input.agentId,
    provider: "slack",
    externalEventId: `${input.eventId}:${input.agentId}`,
    title: slackMessageTitle(input.body),
    body: input.body,
    sourceUrl: `https://slack.com/archives/${input.channelId}/p${input.timestamp.replace(".", "")}`,
    attributes: {
      ...(input.alertProvider
        ? { slackAlertProvider: input.alertProvider }
        : {}),
      ...(input.awsAlarm?.alarmName
        ? { awsAlarmName: input.awsAlarm.alarmName }
        : {}),
      ...(input.awsAlarm?.consoleUrl
        ? { awsAlarmUrl: input.awsAlarm.consoleUrl }
        : {}),
      ...(input.awsAlarm?.region
        ? { awsAlarmRegion: input.awsAlarm.region }
        : {}),
      ...(input.awsAlarm ? { awsAlarmState: input.awsAlarm.state } : {}),
      channelId: input.channelId,
      ...(input.threadMode
        ? {
            integrationAccountId: input.integrationAccountId,
            ...(input.userId ? { slackUserId: input.userId } : {}),
            ...(input.userName ? { slackUserName: input.userName } : {}),
            ...(input.assistant ? { [slackAssistantAttribute]: true } : {}),
          }
        : {}),
      slackEventId: input.eventId,
      teamId: input.teamId,
      threadTimestamp: input.threadTimestamp,
      timestamp: input.timestamp,
    },
  } as const;
  const result = input.threadMode
    ? await queueSlackThreadInvestigation(request, {
        teamId: input.teamId,
        channelId: input.channelId,
        threadTimestamp: input.threadTimestamp,
      })
    : await queueInvestigation(request);
  // The organization is already told when its allowance runs out.
  if (result.kind === "blocked") return null;
  return investigationStartResponseSchema.parse({
    duplicate: result.kind === "duplicate",
    investigationId: result.investigationId,
  });
}

export async function acknowledgeSlackAlert(input: {
  agentId: string;
  assistant?: boolean;
  channelId: string;
  directMessage?: boolean;
  integrationAccountId: string;
  investigationId: string;
  organizationId: string;
  messageTimestamp: string;
  title: string;
  threadTimestamp: string;
  threadMode?: boolean;
}): Promise<void> {
  // A direct message is not one of the workspace's synced channels.
  const connection = input.directMessage
    ? await getConnectedIntegrationAccountCredential({
        integrationAccountId: input.integrationAccountId,
        provider: "slack",
      }).then((account) =>
        account?.organizationId === input.organizationId ? account : null)
    : await getSlackChannelConnection({
        organizationId: input.organizationId,
        integrationAccountId: input.integrationAccountId,
        channelId: input.channelId,
      });
  if (!connection?.encryptedCredentials) {
    throw new Error("Slack alert acknowledgement is not configured");
  }
  const credentials = slackCredentialsSchema.parse(
    decryptCredentials<Record<string, unknown>>(connection.encryptedCredentials),
  );
  const message = investigatingSlackMessage({
    agentId: input.agentId,
    assistant: input.assistant,
    investigationId: input.investigationId,
    organizationId: input.organizationId,
    threadMode: input.threadMode,
    title: input.title,
  });
  const failures: unknown[] = [];
  if (input.threadMode) {
    try {
      await addSlackReaction({
        accessToken: credentials.accessToken,
        channelId: input.channelId,
        name: "eyes",
        timestamp: input.messageTimestamp,
      });
      await setInvestigationSlackReaction(input.investigationId, "eyes", true);
    } catch (error) {
      failures.push(error);
    }
  }
  const liveMessageTimestamp = await postSlackMessage({
    accessToken: credentials.accessToken,
    blocks: message.blocks,
    channelId: input.channelId,
    text: message.text,
    threadTimestamp: input.threadTimestamp,
  });
  if (!liveMessageTimestamp) {
    console.error(
      JSON.stringify({
        channelId: input.channelId,
        event: "investigation_slack_live_message_missing_timestamp",
        investigationId: input.investigationId,
      }),
    );
    throw new Error("Slack did not return the live investigation message timestamp");
  }
  let investigationStatus:
    | "pending"
    | "investigating"
    | "resolved"
    | "failed"
    | null = null;
  try {
    investigationStatus = await recordInvestigationSlackMessage(
      input.investigationId,
      liveMessageTimestamp,
      {
        attachments: [],
        authorName: "Responder",
        blocks: message.blocks,
        key: "investigation-status",
        text: message.text,
      },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        event: "investigation_slack_message_record_failed",
        investigationId: input.investigationId,
      }),
    );
    failures.push(error);
  }
  const results = await Promise.allSettled([
    input.threadMode
      ? Promise.resolve()
      : addSlackReaction({
          accessToken: credentials.accessToken,
          channelId: input.channelId,
          name: "eyes",
          timestamp: input.messageTimestamp,
        }),
    input.threadMode
      ? Promise.resolve()
      : setSlackThreadStatus({
          accessToken: credentials.accessToken,
          channelId: input.channelId,
          loadingMessages: [
            "Gathering evidence…",
            "Checking telemetry…",
            "Inspecting relevant code…",
            "Connecting the dots…",
          ],
          status: "is investigating this alert…",
          threadTimestamp: input.threadTimestamp,
        }),
  ]);
  failures.push(
    ...results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    ),
  );
  if (!input.threadMode && results[0]?.status === "fulfilled") {
    try {
      await setInvestigationSlackReaction(
        input.investigationId,
        "eyes",
        true,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    investigationStatus = await recordInvestigationSlackMessage(
      input.investigationId,
      liveMessageTimestamp,
    );
    if (investigationStatus === "resolved") {
      await reconcileCompletedInvestigationSlackCard(input.investigationId);
    } else if (investigationStatus === "failed") {
      await failInvestigationSlackCard(input.investigationId);
    }
  } catch (error) {
    if (investigationStatus !== "failed") {
      console.error(
        JSON.stringify({
          ...slackErrorLogFields(error),
          event: "investigation_slack_reconcile_failed",
          investigationId: input.investigationId,
        }),
      );
    }
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Unable to fully acknowledge the Slack alert",
    );
  }
}

export function logSlackAcknowledgementFailure(input: {
  alertProvider: SlackAlertProvider | null;
  error: unknown;
  investigationId: string;
}): void {
  console.error(
    JSON.stringify({
      alertProvider: input.alertProvider,
      error:
        input.error instanceof Error
          ? input.error.message
          : String(input.error),
      ...(input.error instanceof AggregateError
        ? {
            errors: input.error.errors.map((reason) =>
              reason instanceof Error ? reason.message : String(reason),
            ),
          }
        : {}),
      event: "slack_alert_acknowledgement_failed",
      investigationId: input.investigationId,
    }),
  );
}

export function investigatingSlackMessage(input: {
  agentId: string;
  assistant?: boolean;
  investigationId: string;
  organizationId?: string;
  threadMode?: boolean;
  title?: string;
}): { blocks: unknown[]; text: string } {
  return slackInvestigationCard({
    agentId: input.agentId,
    assistant: input.assistant,
    detail: input.assistant
      ? "Responder is working on this."
      : "Responder is gathering evidence and preparing the investigation.",
    investigationId: input.investigationId,
    organizationId: input.organizationId,
    showInvestigationLink: input.threadMode !== true,
    status: "in_progress",
    title: input.title ?? (input.assistant ? "Request" : "Investigating alert"),
  });
}

export function slackCopyPromptResponse(prompt: string | null) {
  if (!prompt) {
    return {
      response_type: "ephemeral" as const,
      replace_original: false,
      text: "This issue is no longer available.",
    };
  }

  const prefix = "Here is the prompt containing the investigation context:\n\n```markdown\n";
  const suffix = "\n```";
  const escapedPrompt = prompt.replaceAll("```", "''' ");
  const availablePromptLength = 12_000 - prefix.length - suffix.length;
  const markdown = `${prefix}${escapedPrompt.slice(0, availablePromptLength)}${suffix}`;
  return {
    response_type: "ephemeral" as const,
    replace_original: false,
    text: "Here is the prompt containing the investigation context:",
    blocks: [
      { type: "markdown" as const, text: markdown },
      {
        type: "actions" as const,
        elements: [
          {
            type: "button" as const,
            action_id: "dismiss_copy_prompt",
            text: { type: "plain_text" as const, text: "Dismiss" },
          },
        ],
      },
    ],
  };
}

export function slackPullRequestQueuedResponse(
  card: SlackIssuePullRequestCard,
) {
  const message = slackIssuePullRequestMessage(card);
  return {
    replace_original: true,
    text: message.text,
    blocks: message.blocks,
  };
}

function slackEphemeralResponse(text: string) {
  return {
    response_type: "ephemeral" as const,
    replace_original: false,
    text,
  };
}

function slackPullRequestErrorResponse(error: string) {
  return slackEphemeralResponse(error);
}

// A press of a button an automation's agent added to its message continues
// the run that posted it. The first press is the choice, so the buttons are
// replaced with who pressed which one. Returns what to send to the message's
// response URL.
async function pressAutomationRunButton(
  payload: z.infer<typeof slackBlockActionsSchema>,
  index: number,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const message = payload.message;
  if (!message?.ts) return null;
  const run = await getAutomationRunSlackButtons({
    channelId: payload.channel.id,
    messageTimestamp: message.ts,
    runId,
    teamId: payload.team.id,
  });
  const label = run?.buttons[index];
  if (!run || !label) return slackEphemeralResponse("This button is no longer available.");
  if (!run.automationEnabled) {
    return slackEphemeralResponse("This automation is turned off. Turn it on in Responder, then press the button again.");
  }
  const outcome = await queueAutomationRunReply({
    message: {
      authorId: payload.user.id,
      authorName: payload.user.name || payload.user.username || `<@${payload.user.id}>`,
      externalEventId: `slack_button:${payload.channel.id}:${message.ts}`,
      slackButton: {
        channelId: payload.channel.id,
        integrationAccountId: run.integrationAccountId,
        label,
        messageTimestamp: message.ts,
        threadTimestamp: message.thread_ts ?? message.ts,
      },
      source: "slack",
      text: `Pressed "${label}"`,
    },
    runId,
  });
  console.info(JSON.stringify({ event: "slack_automation_button", outcome, runId }));
  if (outcome === "duplicate") return slackEphemeralResponse("A button on this message was already pressed.");
  return message.blocks
    ? {
        blocks: pressedAutomationButtonBlocks(message.blocks, { label, userId: payload.user.id }),
        replace_original: true,
        text: message.text ?? label,
      }
    : null;
}

async function sendSlackActionResponse(
  responseUrl: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    console.error(`Unable to update Slack action (${response.status})`);
  }
}

function logBlockedSlackInvestigation(input: {
  agentId: string;
  channelId: string;
  eventId: string;
  teamId: string;
}) {
  console.info(
    JSON.stringify({
      ...input,
      event: "slack_investigation_blocked",
      reason: "investigation_allowance_exhausted",
    }),
  );
}

type SlackMessageEvent = z.infer<typeof slackMessageSchema>;
type SlackAgentMatch = Awaited<ReturnType<typeof findAgentsForSlackEvent>>[number];

// Returns false when the organization has no allowance left.
async function startSlackAgentRequest(input: {
  alertProvider: SlackAlertProvider | null;
  awsAlarm: SlackAwsAlarm | null;
  body: string;
  directMessage?: boolean;
  event: SlackMessageEvent;
  eventId: string;
  match: SlackAgentMatch;
  teamId: string;
}): Promise<boolean> {
  const { event, match } = input;
  const threadMode = match.trigger === "slack_thread";
  const assistant = threadMode &&
    await organizationHasCapability(match.organizationId, "simplified_navigation");
  const result = await forwardSlackEvent({
    agentId: match.agentId,
    alertProvider: input.alertProvider,
    assistant,
    awsAlarm: input.awsAlarm,
    body: input.body,
    channelId: event.channel,
    eventId: input.eventId,
    integrationAccountId: match.integrationAccountId,
    teamId: input.teamId,
    threadTimestamp: event.thread_ts ?? event.ts,
    timestamp: event.ts,
    threadMode,
    userId: event.user,
    userName: event.username?.trim() || undefined,
  });
  if (!result) {
    logBlockedSlackInvestigation({
      agentId: match.agentId,
      channelId: event.channel,
      eventId: input.eventId,
      teamId: input.teamId,
    });
    return false;
  }
  await recordInvestigationSlackSource(result.investigationId, {
    attachments: event.attachments ?? [],
    authorName: slackMessageAuthor(event),
    blocks: event.blocks ?? [],
    slackTimestamp: event.ts,
    text: event.text,
  });
  if (
    !result.duplicate &&
    (match.trigger === "slack_channel" || match.trigger === "slack_thread")
  ) {
    await acknowledgeSlackAlert({
      agentId: match.agentId,
      assistant,
      channelId: event.channel,
      directMessage: input.directMessage,
      integrationAccountId: match.integrationAccountId,
      investigationId: result.investigationId,
      organizationId: match.organizationId,
      messageTimestamp: event.ts,
      title: slackMessageTitle(input.body),
      threadTimestamp: event.thread_ts ?? event.ts,
      threadMode,
    }).catch((error: unknown) => {
      logSlackAcknowledgementFailure({
        alertProvider: input.alertProvider,
        error,
        investigationId: result.investigationId,
      });
    });
  }
  return true;
}

export const slackTagModeOffReply =
  "I can't answer direct messages in this workspace yet. Ask a workspace admin to turn on Tag mode.";
export const slackAllowanceExhaustedReply =
  "I can't take new requests right now because this workspace has reached its usage limit.";

export function slackWelcomeMessage(botUserId?: string): string {
  return [
    "Hi! Send me a message here to ask about your alerts, systems, or code.",
    "Each message starts a new conversation. Reply in its thread to continue it.",
    `You can also mention ${botUserId ? `<@${botUserId}>` : "me"} in any channel.`,
  ].join(" ");
}

function slackAccountToken(encryptedCredentials: string): string {
  return slackCredentialsSchema.parse(
    decryptCredentials<Record<string, unknown>>(encryptedCredentials),
  ).accessToken;
}

// Uses the organization's own token when one is named.
async function replyInSlackDirectMessage(input: {
  channelId: string;
  integrationAccountId?: string;
  teamId: string;
  text: string;
  threadTimestamp: string;
}): Promise<void> {
  const accounts = await listConnectedSlackAccountsForTeam(input.teamId);
  const account = accounts.find((candidate) => candidate.id === input.integrationAccountId) ??
    accounts[0];
  if (!account?.encryptedCredentials) return;
  try {
    await postSlackMessage({
      accessToken: slackAccountToken(account.encryptedCredentials),
      channelId: input.channelId,
      text: input.text,
      threadTimestamp: input.threadTimestamp,
    });
  } catch (error) {
    console.error(JSON.stringify({
      ...slackErrorLogFields(error),
      event: "slack_direct_message_reply_failed",
      teamId: input.teamId,
    }));
  }
}

// Tag mode can't open Slack files, so it is told their names instead.
export function slackDirectMessageBody(event: SlackMessageEvent): string {
  const fileNames = (event.files ?? [])
    .map((file) => file.name?.trim() || file.title?.trim())
    .filter((name): name is string => Boolean(name));
  if (fileNames.length === 0) return slackMessageBody(event);
  const fileNote = `The person attached files you can't open: ${fileNames.join(", ")}`;
  return [slackMessageContent(event), fileNote].filter(Boolean).join("\n\n");
}

// A direct message works like a mention: tag mode answers in the message's
// thread, and a reply in that thread continues the conversation.
export async function answerSlackDirectMessage(input: {
  event: SlackMessageEvent;
  eventId: string;
  teamId: string;
}) {
  const { event } = input;
  const author = slackEventAuthor(event);
  // The app's own replies arrive as direct messages too.
  if (author?.kind !== "person") {
    return { ok: true, ignored: true, reason: "direct_message_from_app" };
  }
  const threadTimestamp = event.thread_ts ?? event.ts;
  const body = slackDirectMessageBody(event);
  const matches = await findAgentsForSlackEvent({
    channelId: event.channel,
    eventType: "direct_message",
    teamId: input.teamId,
    userId: author.id,
  });
  if (matches.length === 0) {
    await replyInSlackDirectMessage({
      channelId: event.channel,
      teamId: input.teamId,
      text: slackTagModeOffReply,
      threadTimestamp,
    });
    return { ok: true, matchedAgents: 0 };
  }
  const started = await Promise.all(
    matches.map((match) =>
      startSlackAgentRequest({
        alertProvider: null,
        awsAlarm: null,
        body,
        directMessage: true,
        event,
        eventId: input.eventId,
        match,
        teamId: input.teamId,
      })),
  );
  // Another organization on the workspace may still answer.
  if (!started.some(Boolean)) {
    await replyInSlackDirectMessage({
      channelId: event.channel,
      integrationAccountId: matches[0]?.integrationAccountId,
      teamId: input.teamId,
      text: slackAllowanceExhaustedReply,
      threadTimestamp,
    });
  }
  return { ok: true, matchedAgents: matches.length };
}

// Welcomes a person the first time they open the app's messages tab.
export async function welcomeToSlackMessagesTab(input: {
  channelId: string;
  teamId: string;
  userId: string;
}): Promise<boolean> {
  const [account] = await listConnectedSlackAccountsForTeam(input.teamId);
  if (!account?.encryptedCredentials) return false;
  const claim = { teamId: input.teamId, userId: input.userId };
  if (!(await claimSlackDirectMessageWelcome(claim))) return false;
  try {
    const botUserId = typeof account.metadata.botUserId === "string"
      ? account.metadata.botUserId
      : undefined;
    await postSlackMessage({
      accessToken: slackAccountToken(account.encryptedCredentials),
      channelId: input.channelId,
      text: slackWelcomeMessage(botUserId),
    });
  } catch (error) {
    await releaseSlackDirectMessageWelcome(claim).catch(() => undefined);
    console.error(JSON.stringify({
      ...slackErrorLogFields(error),
      event: "slack_welcome_message_failed",
      teamId: input.teamId,
    }));
    return false;
  }
  // An unmarked claim expires, so a failure here can repeat the welcome.
  await markSlackDirectMessageWelcomeSent(claim).catch((error: unknown) => {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      event: "slack_welcome_message_record_failed",
      teamId: input.teamId,
    }));
  });
  return true;
}

export const slackWebhookRoutes = new Hono().post("/", async (context) => {
  const rawBody = await context.req.text();
  if (
    !verifySlackSignature({
      rawBody,
      signature: context.req.header("x-slack-signature"),
      timestamp: context.req.header("x-slack-request-timestamp"),
    })
  ) {
    return context.json({ error: "Invalid Slack signature" }, 401);
  }

  const payload = parseJson(rawBody);
  const verification = slackUrlVerificationSchema.safeParse(payload);
  if (verification.success) {
    return context.json({ challenge: verification.data.challenge });
  }

  const appHomeOpened = slackAppHomeOpenedSchema.safeParse(payload);
  if (appHomeOpened.success) {
    const { event, team_id: teamId } = appHomeOpened.data;
    const welcomed = event.tab === "messages" &&
      await welcomeToSlackMessagesTab({
        channelId: event.channel,
        teamId,
        userId: event.user,
      });
    return context.json({ ok: true, welcomed });
  }

  const callback = slackEventCallbackSchema.safeParse(payload);
  if (!callback.success) {
    return context.json({ ok: true, ignored: true });
  }
  const { event } = callback.data;
  // Direct message channel IDs start with D.
  const directMessage = event.channel_type === "im" || event.channel.startsWith("D");
  // A mention with a file arrives without a subtype; a direct message with a
  // file arrives as a file share.
  if (
    !isSupportedSlackMessageSubtype(event.subtype) &&
    !(directMessage && event.subtype === "file_share")
  ) {
    console.info(
      JSON.stringify({
        channelId: event.channel,
        event: "slack_webhook_ignored",
        eventId: callback.data.event_id,
        reason: "unsupported_message_subtype",
        subtype: event.subtype ?? null,
        teamId: callback.data.team_id,
      }),
    );
    return context.json({ ok: true, ignored: true });
  }

  if (directMessage) {
    // Slack sends a direct message as a message event, so a mention there
    // would answer it twice.
    if (event.type === "app_mention") {
      return context.json({ ok: true, ignored: true });
    }
    return context.json(await answerSlackDirectMessage({
      event,
      eventId: callback.data.event_id,
      teamId: callback.data.team_id,
    }));
  }
  const rawMessageBody = slackMessageBody(event);
  const body = event.type === "app_mention"
    ? rawMessageBody.replace(/^\s*<@[A-Z0-9]+>\s*/iu, "").trim() || rawMessageBody
    : rawMessageBody;
  const senderName = event.bot_profile?.name ?? event.username;
  const alertProvider = event.type === "message"
    ? slackAlertProvider({
      body,
      botAppId: event.app_id ?? event.bot_profile?.app_id,
      botId: event.bot_id,
      botName: event.bot_profile?.name,
      subtype: event.subtype,
      username: event.username,
    })
    : null;
  const ignoreReason = alertProvider
    ? slackAlertIgnoreReason({
      alertProvider,
      body,
      senderName,
      subtype: event.subtype,
    })
    : null;
  if (ignoreReason) {
    console.info(
      JSON.stringify({
        botAppId: event.app_id ?? event.bot_profile?.app_id ?? null,
        botId: event.bot_id ?? null,
        channelId: event.channel,
        event: "slack_app_alert_ignored",
        eventId: callback.data.event_id,
        reason: ignoreReason,
        teamId: callback.data.team_id,
      }),
    );
    return context.json({ ok: true, ignored: true, reason: ignoreReason });
  }

  const author = slackEventAuthor(event);
  const automationMatches = await findAutomationsForSlackEvent({
    authorIds: author?.ids ?? [],
    channelId: event.channel,
    eventType: event.type,
    teamId: callback.data.team_id,
    text: rawMessageBody,
    threadTimestamp: event.thread_ts,
  });
  if (author) {
    // The trigger editor offers the people and apps seen here as authors to
    // ignore. A failure only leaves that list a message behind.
    await Promise.all(
      [...new Set(automationMatches.map((match) => match.integrationAccountId))].map((integrationAccountId) =>
        recordSlackMessageAuthor({
          authorId: author.id,
          channelId: event.channel,
          integrationAccountId,
          kind: author.kind,
          name: author.name ?? author.id,
        }).catch((error: unknown) => {
          console.error(JSON.stringify({
            errorCode: error instanceof Error ? error.name : typeof error,
            event: "slack_message_author_record_failed",
            eventId: callback.data.event_id,
          }));
        })
      ),
    );
  }
  // A person replying in a thread that an automation is working in continues
  // that run.
  const reply = event.thread_ts && author?.kind === "person"
    ? {
        authorId: author.id,
        authorName: author.name || `<@${author.id}>`,
        // Slack sends a mention as both a message and an app_mention event.
        externalEventId: `${event.channel}:${event.ts}`,
        source: "slack" as const,
        text: body,
      }
    : null;
  // Organizations with an automation run working in this thread, or one this
  // mention starts. The run answers there, so the organization's agents stay
  // out of it.
  const automationThreadOrganizations = new Set<string>();
  const automationResults = await Promise.allSettled(
    automationMatches.map(async (match) => {
      if (event.thread_ts) {
        const run = await findSlackThreadAutomationRun({
          automationId: match.automationId,
          channelId: event.channel,
          teamId: callback.data.team_id,
          threadTimestamp: event.thread_ts,
        });
        // A redelivery of the message that started this run is not a reply;
        // starting the run again finds it as a duplicate.
        if (run && run.triggerTimestamp !== event.ts) {
          if (reply) {
            // A reply that fails to queue leaves the run failed, so the
            // organization's agents may still answer it.
            const outcome = await queueAutomationRunReply({ message: reply, runId: run.id });
            automationThreadOrganizations.add(run.organizationId);
            console.info(JSON.stringify({
              automationId: match.automationId,
              event: "slack_automation_reply",
              eventId: callback.data.event_id,
              outcome,
              runId: run.id,
            }));
            return;
          }
          // Another app answering in the thread, such as another agent,
          // would start a run that answers it back, and so on.
          automationThreadOrganizations.add(run.organizationId);
          console.info(JSON.stringify({
            automationId: match.automationId,
            event: "slack_automation_app_reply_ignored",
            eventId: callback.data.event_id,
            runId: run.id,
          }));
          return;
        }
      }
      if (!match.startsRun) return;
      await queueAutomationRun({
        automationId: match.automationId,
        trigger: {
          attributes: {
            ...(author
              ? {
                  authorId: author.id,
                  ...(author.name ? { authorName: author.name } : {}),
                  authorType: author.kind,
                }
              : {}),
            channelId: event.channel,
            mentioned: match.mentioned,
            teamId: callback.data.team_id,
            threadTimestamp: event.thread_ts ?? event.ts,
            timestamp: event.ts,
          },
          body,
          externalEventId: `${callback.data.event_id}:${match.automationId}`,
          provider: "slack",
          sourceUrl: `https://slack.com/archives/${event.channel}/p${event.ts.replace(".", "")}`,
          title: slackMessageTitle(body),
        },
      });
      if (match.mentioned) automationThreadOrganizations.add(match.organizationId);
    }),
  );
  if (automationResults.some((result) => result.status === "rejected")) {
    console.error(JSON.stringify({
      event: "slack_automation_fanout_failed",
      eventId: callback.data.event_id,
      failedCount: automationResults.filter((result) => result.status === "rejected").length,
    }));
  }
  if (event.type === "app_mention" && event.thread_ts) {
    const linked = await findSlackIssueThread({
      channelId: event.channel,
      teamId: callback.data.team_id,
      threadTimestamp: event.thread_ts,
    }).catch(() => null);
    if (linked && !automationThreadOrganizations.has(linked.organizationId)) {
      const priorIssues = linked.issues
        .map((issue) => [
          `Issue ${issue.id}: ${issue.title}`,
          `Description: ${issue.description}`,
          `Root cause: ${issue.rootCause || "Not established"}`,
          `Current remediation: ${issue.remediation}`,
          `Remediation options: ${JSON.stringify(issue.remediations)}`,
        ].join("\n"))
        .join("\n\n");
      const priorContext = [
        "This is follow-up feedback on an existing issue investigation.",
        `Original investigation ID: ${linked.id}`,
        linked.reportMarkdown ? `Original report:\n${linked.reportMarkdown}` : null,
        priorIssues,
        `Latest Slack feedback from ${event.user ?? "a teammate"}:\n${body}`,
      ].filter((value): value is string => Boolean(value)).join("\n\n");
      const result = await queueInvestigation(
        {
          agentId: linked.agentId,
          provider: "slack",
          externalEventId: `${callback.data.event_id}:${linked.agentId}`,
          title: `Follow-up: ${linked.issueTitle}`,
          body: priorContext,
          sourceUrl: `https://slack.com/archives/${event.channel}/p${event.ts.replace(".", "")}`,
          attributes: {
            channelId: event.channel,
            integrationAccountId: linked.integrationAccountId,
            slackEventId: callback.data.event_id,
            teamId: callback.data.team_id,
            threadTimestamp: event.thread_ts,
            timestamp: event.ts,
            originalInvestigationId: linked.id,
          },
        },
        {
          slackIssueFollowup: {
            originalInvestigationId: linked.id,
            issueIds: linked.issueIds,
            channelId: event.channel,
            threadTimestamp: event.thread_ts,
          },
        },
      );
      if (result.kind === "blocked") {
        logBlockedSlackInvestigation({
          agentId: linked.agentId,
          channelId: event.channel,
          eventId: callback.data.event_id,
          teamId: callback.data.team_id,
        });
        return context.json({ ok: true, followup: true, blocked: true });
      }
      return context.json({
        ok: true,
        matchedAgents: 1,
        followup: true,
        investigationId: result.investigationId,
      });
    }
  }
  let matches: Awaited<ReturnType<typeof findAgentsForSlackEvent>> = [];
  let awsAlarm: SlackAwsAlarm | null = null;
  if (event.type === "message") {
    if (!alertProvider) {
      console.info(
        JSON.stringify({
          botAppId: event.app_id ?? event.bot_profile?.app_id ?? null,
          botId: event.bot_id ?? null,
          channelId: event.channel,
          event: "slack_webhook_ignored",
          eventId: callback.data.event_id,
          reason: "unsupported_alert_sender",
          subtype: event.subtype ?? null,
          teamId: callback.data.team_id,
        }),
      );
      return context.json({
        ok: true,
        ignored: true,
        reason: "unsupported_alert_sender",
      });
    }
    if (alertProvider === "aws") {
      awsAlarm = slackAwsAlarm({ body, senderName });
    }
    if (alertProvider === "app" || alertProvider === "aws") {
      logAcceptedSlackAppAlert({
        botAppId: event.app_id ?? event.bot_profile?.app_id ?? null,
        botId: event.bot_id ?? null,
        channelId: event.channel,
        eventId: callback.data.event_id,
        subtype: event.subtype ?? null,
        teamId: callback.data.team_id,
        timestamp: event.ts,
      });
    }
  }

  matches = await findAgentsForSlackEvent({
    teamId: callback.data.team_id,
    channelId: event.channel,
    eventType: event.type,
    userId: event.user,
    senderAppId: event.app_id ?? event.bot_profile?.app_id,
  }) ?? [];
  matches = matches.filter((match) => !automationThreadOrganizations.has(match.organizationId));
  await Promise.all(
    matches.map((match) =>
      startSlackAgentRequest({
        alertProvider,
        awsAlarm,
        body,
        event,
        eventId: callback.data.event_id,
        match,
        teamId: callback.data.team_id,
      })),
  );

  return context.json({
    ok: true,
    matchedAgents: matches.length,
    ...(automationMatches.length > 0
      ? { matchedAutomations: automationMatches.length }
      : {}),
  });
}).post("/actions", async (context) => {
  const rawBody = await context.req.text();
  if (
    !verifySlackSignature({
      rawBody,
      signature: context.req.header("x-slack-signature"),
      timestamp: context.req.header("x-slack-request-timestamp"),
    })
  ) {
    return context.json({ error: "Invalid Slack signature" }, 401);
  }

  const form = new URLSearchParams(rawBody);
  const action = slackBlockActionsSchema.safeParse(
    parseJson(form.get("payload") ?? ""),
  );
  if (!action.success) return context.json({ ok: true, ignored: true });

  if (!action.data.response_url.startsWith("https://hooks.slack.com/actions/")) {
    return context.json({ error: "Invalid Slack response URL" }, 400);
  }

  const automationButton = action.data.actions
    .map((item) => ({ index: automationButtonIndex(item.action_id), item }))
    .find((candidate) => candidate.index !== null);
  if (automationButton) {
    const runId = z.uuid().safeParse(automationButton.item.value);
    if (!runId.success) return context.json({ ok: true });
    // The press is stored and queued before Slack hears back, so a restart
    // cannot lose it.
    let response: Record<string, unknown> | null;
    try {
      response = await pressAutomationRunButton(
        action.data,
        automationButton.index!,
        runId.data,
      );
    } catch (error) {
      console.error(JSON.stringify({
        errorCode: error instanceof Error ? error.name : typeof error,
        event: "slack_automation_button_failed",
        runId: runId.data,
      }));
      response = slackEphemeralResponse("Responder could not continue the run. Continue it from the run page in Responder.");
    }
    // Slack expects an answer within three seconds, and the response URL
    // accepts the update later.
    if (response) {
      void sendSlackActionResponse(action.data.response_url, response).catch((error: unknown) => {
        console.error(JSON.stringify({
          errorCode: error instanceof Error ? error.name : typeof error,
          event: "slack_automation_button_response_failed",
          runId: runId.data,
        }));
      });
    }
    return context.json({ ok: true });
  }

  const dismissAction = action.data.actions.find(
    (item) => item.action_id === "dismiss_copy_prompt",
  );
  if (dismissAction) {
    const response = await fetch(action.data.response_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delete_original: true }),
    });
    if (!response.ok) {
      console.error(`Unable to dismiss Slack issue prompt (${response.status})`);
    }
    return context.json({ ok: true });
  }

  const feedbackAction = action.data.actions.find(
    (item) => item.action_id === "feedback",
  );
  const feedbackInvestigationId = investigationIdFromFeedbackBlockId(
    feedbackAction?.block_id,
  );
  const feedback = investigationFeedbackSchema.safeParse(
    feedbackAction?.value,
  );
  if (feedbackInvestigationId && feedback.success) {
    const investigation = await getInvestigationForSlackAction({
      investigationId: feedbackInvestigationId,
      teamId: action.data.team.id,
    });
    if (investigation) {
      await captureAnalyticsEvent({
        distinctId: `slack:${action.data.team.id}:${action.data.user.id}`,
        event: "investigation feedback submitted",
        organizationId: investigation.organizationId,
        properties: {
          $process_person_profile: false,
          agent_id: investigation.agentId,
          channel_id: action.data.channel.id,
          feedback: feedback.data,
          investigation_id: investigation.id,
          message_timestamp: action.data.message?.ts,
          slack_user_id: action.data.user.id,
          surface: "slack",
          team_id: action.data.team.id,
          user_name: action.data.user.name ?? action.data.user.username,
        },
      });
    }
    return context.json({ ok: true });
  }

  const removeAction = action.data.actions.find(
    (item) => item.action_id === "remove",
  );
  const removedInvestigationId = investigationIdFromFeedbackBlockId(
    removeAction?.block_id,
  );
  if (removedInvestigationId) {
    const response = await fetch(action.data.response_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delete_original: true }),
    });
    if (!response.ok) {
      console.error(
        `Unable to remove Slack investigation message (${response.status})`,
      );
    } else if (action.data.message?.ts) {
      await removeInvestigationSlackReply(
        removedInvestigationId,
        "investigation-status",
        action.data.message.ts,
      );
    }
    return context.json({ ok: true });
  }

  const pullRequestAction = action.data.actions.find(
    (item) => item.action_id === "create_issue_pull_request",
  );
  if (pullRequestAction?.value) {
    const selection = parseSlackRemediationActionValue(
      pullRequestAction.value,
    );
    try {
      const result = await startSlackIssueRemediation({
        issueId: selection?.issueId ?? pullRequestAction.value,
        ...(selection ? { remediationId: selection.remediationId } : {}),
        teamId: action.data.team.id,
      });
      const response = result.ok === true
        ? slackPullRequestQueuedResponse(result.card)
        : slackPullRequestErrorResponse(result.error);
      await sendSlackActionResponse(
        action.data.response_url,
        response,
      );
      if (result.ok && action.data.message?.ts) {
        try {
          await registerIssuePullRequestSlackMessage({
            channelId: action.data.channel.id,
            integrationAccountId: result.integrationAccountId,
            messageTimestamp: action.data.message.ts,
            requestId: result.requestId,
          });
          await refreshIssuePullRequestSlackMessages(result.requestId);
        } catch (error) {
          console.error(
            "Unable to register Slack pull request status card",
            error,
          );
        }
      }
    } catch (error) {
      const message =
        error instanceof IssuePullRequestError
          ? error.message
          : "Unable to start pull request creation";
      console.error("Unable to start Slack pull request creation", error);
      await sendSlackActionResponse(
        action.data.response_url,
        slackPullRequestErrorResponse(message),
      );
    }
    return context.json({ ok: true });
  }

  const copyAction = action.data.actions.find(
    (item) => item.action_id === "copy_issue_prompt",
  );
  if (!copyAction?.value) return context.json({ ok: true });

  const copySelection = parseSlackRemediationActionValue(copyAction.value);
  const copyIssueId = copySelection?.issueId ?? copyAction.value;

  const issue = await getIssueForSlackAction({
    issueId: copyIssueId,
    teamId: action.data.team.id,
  });
  await captureAnalyticsEvent({
    distinctId: `slack:${action.data.team.id}:${action.data.user.id}`,
    event: "prompt copied",
    organizationId: issue?.organizationId,
    properties: {
      $process_person_profile: false,
      channel_id: action.data.channel.id,
      issue_found: Boolean(issue),
      issue_id: copyIssueId,
      surface: "slack",
      team_id: action.data.team.id,
    },
  });
  const externalRemediation = issue?.remediations?.find(
    (remediation) =>
      remediation.type === "external_action" &&
      (!copySelection || remediation.id === copySelection.remediationId),
  );
  const prompt = issue
    ? externalRemediation?.type === "external_action"
      ? externalRemediation.agentPrompt
      : renderIssueFixPrompt(issue)
    : null;
  const promptResponse = slackCopyPromptResponse(prompt);
  if (
    issue?.encryptedCredentials &&
    prompt &&
    "blocks" in promptResponse &&
    promptResponse.blocks
  ) {
    try {
      const credentials = slackCredentialsSchema.parse(
        decryptCredentials<Record<string, unknown>>(
          issue.encryptedCredentials,
        ),
      );
      await postSlackEphemeralMessage({
        accessToken: credentials.accessToken,
        blocks: promptResponse.blocks,
        channelId: action.data.channel.id,
        text: promptResponse.text,
        threadTimestamp: action.data.message?.thread_ts,
        userId: action.data.user.id,
      });
      return context.json({ ok: true });
    } catch (error) {
      console.error("Unable to post Slack markdown issue prompt", error);
      const escapedPrompt = prompt.replaceAll("```", "''' ").slice(0, 12_000);
      const fallback = await fetch(action.data.response_url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          response_type: "ephemeral",
          replace_original: false,
          text: `Here is the prompt containing the investigation context:\n\n\`\`\`${escapedPrompt}\`\`\``,
        }),
      });
      if (!fallback.ok) {
        console.error(
          `Unable to return fallback Slack issue prompt (${fallback.status})`,
        );
      }
      return context.json({ ok: true });
    }
  }

  const response = await fetch(action.data.response_url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(promptResponse),
  });
  if (!response.ok) {
    console.error(`Unable to return unavailable Slack issue (${response.status})`);
  }
  return context.json({ ok: true });
});
