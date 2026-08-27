import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { captureAnalyticsEvent } from "@responder/core/analytics";
import { decryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import { findAgentsForSlackEvent } from "../../../../packages/core/src/db/agents.js";
import { getSlackChannelConnection } from "../../../../packages/core/src/db/integrations.js";
import {
  getInvestigationForSlackAction,
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
import {
  parseSlackRemediationActionValue,
  refreshIssuePullRequestSlackMessages,
  slackIssuePullRequestMessage,
  type SlackIssuePullRequestCard,
} from "../../../../packages/core/src/integrations/slack-remediations.js";
import { startSlackIssueRemediation } from "../issues/remediation.js";
import { queueInvestigation } from "../investigations/queue.js";

const slackUrlVerificationSchema = z.object({
  type: z.literal("url_verification"),
  challenge: z.string().min(1),
});

const slackMessageSchema = z.object({
  type: z.enum(["message", "app_mention"]),
  channel: z.string().min(1),
  ts: z.string().min(1),
  thread_ts: z.string().optional(),
  user: z.string().optional(),
  app_id: z.string().optional(),
  bot_id: z.string().optional(),
  username: z.string().optional(),
  text: z.string().optional().default(""),
  subtype: z.string().optional(),
  bot_profile: z
    .object({
      app_id: z.string().optional(),
      name: z.string().optional(),
    })
    .passthrough()
    .optional(),
  blocks: z.array(z.unknown()).optional(),
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

export function slackMessageBody(
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
    .slice(0, 100_000) || "A new alert was posted in the configured Slack channel.";
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

type SlackAlertProvider = "app" | "aws" | "datadog" | "sentry";

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
    if (/\bsentry\b/i.test(senderName)) return "sentry";
    return /\balert\b/i.test(input.body) ? "app" : null;
  }

  if (/https:\/\/[^>\s]*datadoghq\.(?:com|eu)\//i.test(input.body)) {
    return "datadog";
  }
  if (/https:\/\/[^>\s]*sentry\.io\//i.test(input.body)) {
    return "sentry";
  }
  return /\balert\b/i.test(input.body) ? "app" : null;
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
  awsAlarm: SlackAwsAlarm | null;
  body: string;
  channelId: string;
  eventId: string;
  teamId: string;
  threadTimestamp: string;
  timestamp: string;
}) {
  const result = await queueInvestigation({
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
      slackEventId: input.eventId,
      teamId: input.teamId,
      threadTimestamp: input.threadTimestamp,
      timestamp: input.timestamp,
    },
  });
  if (result.kind === "blocked") {
    throw new Error("Monthly investigation allowance exhausted");
  }
  return investigationStartResponseSchema.parse({
    duplicate: result.kind === "duplicate",
    investigationId: result.investigationId,
  });
}

export async function acknowledgeSlackAlert(input: {
  agentId: string;
  channelId: string;
  integrationAccountId: string;
  investigationId: string;
  organizationId: string;
  messageTimestamp: string;
  title: string;
  threadTimestamp: string;
}): Promise<void> {
  const connection = await getSlackChannelConnection({
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
    investigationId: input.investigationId,
    title: input.title,
  });
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
  const failures: unknown[] = [];
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
    addSlackReaction({
      accessToken: credentials.accessToken,
      channelId: input.channelId,
      name: "eyes",
      timestamp: input.messageTimestamp,
    }),
    setSlackThreadStatus({
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
  if (results[0]?.status === "fulfilled") {
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
    if (investigationStatus && investigationStatus !== "failed") {
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
  investigationId: string;
  title?: string;
}): { blocks: unknown[]; text: string } {
  return slackInvestigationCard({
    agentId: input.agentId,
    detail: "Responder is gathering evidence and preparing the investigation.",
    investigationId: input.investigationId,
    status: "in_progress",
    title: input.title ?? "Investigating alert",
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

function slackPullRequestErrorResponse(error: string) {
  return {
    response_type: "ephemeral" as const,
    replace_original: false,
    text: error,
  };
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

  const callback = slackEventCallbackSchema.safeParse(payload);
  if (!callback.success) {
    return context.json({ ok: true, ignored: true });
  }
  const { event } = callback.data;
  if (!isSupportedSlackMessageSubtype(event.subtype)) {
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

  const body = slackMessageBody(event);
  let alertProvider: SlackAlertProvider | null = null;
  let awsAlarm: SlackAwsAlarm | null = null;
  if (event.type === "message") {
    const senderName = event.bot_profile?.name ?? event.username;
    alertProvider = slackAlertProvider({
      body,
      botAppId: event.app_id ?? event.bot_profile?.app_id,
      botId: event.bot_id,
      botName: event.bot_profile?.name,
      subtype: event.subtype,
      username: event.username,
    });
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
    if (
      shouldIgnoreResolvedSlackAlert(
        alertProvider,
        body,
        senderName,
      )
    ) {
      console.info(
        JSON.stringify({
          botAppId: event.app_id ?? event.bot_profile?.app_id ?? null,
          botId: event.bot_id ?? null,
          channelId: event.channel,
          event: "slack_app_alert_ignored",
          eventId: callback.data.event_id,
          reason: "resolved_alert",
          teamId: callback.data.team_id,
        }),
      );
      return context.json({
        ok: true,
        ignored: true,
        reason: "resolved_alert",
      });
    }
    if (alertProvider === "app" && isSlackErrorRecap(body)) {
      console.info(
        JSON.stringify({
          botAppId: event.app_id ?? event.bot_profile?.app_id ?? null,
          botId: event.bot_id ?? null,
          channelId: event.channel,
          event: "slack_app_alert_ignored",
          eventId: callback.data.event_id,
          reason: "error_recap",
          teamId: callback.data.team_id,
        }),
      );
      return context.json({
        ok: true,
        ignored: true,
        reason: "error_recap",
      });
    }
    if (
      alertProvider === "sentry" &&
      !isSentryIssueAlert(body, event.subtype)
    ) {
      return context.json({
        ok: true,
        ignored: true,
        reason: "unsupported_sentry_message",
      });
    }
    if (alertProvider === "datadog" && isDatadogRecoveryMessage(body)) {
      return context.json({
        ok: true,
        ignored: true,
        reason: "datadog_recovery",
      });
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

  const matches = await findAgentsForSlackEvent({
    teamId: callback.data.team_id,
    channelId: event.channel,
    eventType: event.type,
    userId: event.user,
    senderAppId: event.app_id ?? event.bot_profile?.app_id,
  });
  await Promise.all(
    matches.map(async (match) => {
      const result = await forwardSlackEvent({
        agentId: match.agentId,
        alertProvider,
        awsAlarm,
        body,
        channelId: event.channel,
        eventId: callback.data.event_id,
        teamId: callback.data.team_id,
        threadTimestamp: event.thread_ts ?? event.ts,
        timestamp: event.ts,
      });
      await recordInvestigationSlackSource(result.investigationId, {
        attachments: event.attachments ?? [],
        authorName: slackMessageAuthor(event),
        blocks: event.blocks ?? [],
        slackTimestamp: event.ts,
        text: event.text,
      });
      if (!result.duplicate && match.trigger === "slack_channel") {
        await acknowledgeSlackAlert({
          agentId: match.agentId,
          channelId: event.channel,
          integrationAccountId: match.integrationAccountId,
          investigationId: result.investigationId,
          organizationId: match.organizationId,
          messageTimestamp: event.ts,
          title: slackMessageTitle(body),
          threadTimestamp: event.thread_ts ?? event.ts,
        }).catch((error: unknown) => {
          logSlackAcknowledgementFailure({
            alertProvider,
            error,
            investigationId: result.investigationId,
          });
        });
      }
    }),
  );

  return context.json({ ok: true, matchedAgents: matches.length });
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
