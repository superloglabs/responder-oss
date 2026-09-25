import { createHash } from "node:crypto";
import { z } from "zod";
import type { AutomationContextBrokerClaim } from "../../../../packages/core/src/db/automation-model-broker.js";
import {
  appendAutomationRunEvent,
  beginAutomationActionAttempt,
  completeAutomationActionAttempt,
  failAutomationActionAttempt,
} from "../../../../packages/core/src/db/automations.js";
import type { AutomationActionKind } from "../../../../packages/core/src/db/schema.js";
import { decryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import {
  addSlackReaction,
  postSlackMessage,
  SlackApiError,
} from "../../../../packages/core/src/integrations/slack.js";
import {
  readSlackChannelHistory,
  readSlackThread,
  slackTimestampPattern,
} from "../../../../packages/core/src/integrations/slack-history.js";
import { searchSlackChannel } from "../../../../packages/core/src/integrations/slack-search.js";

// Slack tools for automation runs. A context link grants every tool on the
// connection's available channels. A trigger link, or any link when Slack
// started the run, grants reading, replying, and reacting in that thread.

export interface SlackToolDependencies {
  addReaction: typeof addSlackReaction;
  appendEvent: typeof appendAutomationRunEvent;
  beginAttempt: typeof beginAutomationActionAttempt;
  completeAttempt: typeof completeAutomationActionAttempt;
  failAttempt: typeof failAutomationActionAttempt;
  postMessage: typeof postSlackMessage;
  readChannel: typeof readSlackChannelHistory;
  readThread: typeof readSlackThread;
  search: typeof searchSlackChannel;
}

export const defaultSlackToolDependencies: SlackToolDependencies = {
  addReaction: addSlackReaction,
  appendEvent: appendAutomationRunEvent,
  beginAttempt: beginAutomationActionAttempt,
  completeAttempt: completeAutomationActionAttempt,
  failAttempt: failAutomationActionAttempt,
  postMessage: postSlackMessage,
  readChannel: readSlackChannelHistory,
  readThread: readSlackThread,
  search: searchSlackChannel,
};

interface SlackTriggerThread {
  channelId: string;
  threadTimestamp: string;
  timestamp: string;
}

interface SlackToolScope {
  // Channels with full access, by ID.
  channels: Map<string, string>;
  thread: SlackTriggerThread | null;
}

const timestampSchema = z.string().regex(slackTimestampPattern);
const cursorSchema = z.string().min(1).max(500);
const slackTriggerSchema = z.object({
  attributes: z.object({
    channelId: z.string().min(1),
    teamId: z.string().min(1),
    threadTimestamp: timestampSchema,
    timestamp: timestampSchema,
  }),
  provider: z.literal("slack"),
});

export function slackToolScope(claim: AutomationContextBrokerClaim): SlackToolScope {
  const channels = new Map(
    claim.roles.includes("context")
      ? claim.resources
          .filter((resource) => resource.kind === "slack_channel")
          .map((resource) => [resource.externalId, resource.displayName])
      : [],
  );
  const trigger = slackTriggerSchema.safeParse(claim.trigger);
  const thread = trigger.success &&
      trigger.data.attributes.teamId === claim.account.externalAccountId
    ? {
        channelId: trigger.data.attributes.channelId,
        threadTimestamp: trigger.data.attributes.threadTimestamp,
        timestamp: trigger.data.attributes.timestamp,
      }
    : null;
  return { channels, thread };
}

function inTriggerThread(
  scope: SlackToolScope,
  channelId: string,
  threadTimestamp: string | undefined,
): boolean {
  return scope.thread !== null &&
    scope.thread.channelId === channelId &&
    scope.thread.threadTimestamp === threadTimestamp;
}

function threadNote(scope: SlackToolScope): string {
  if (!scope.thread) return "";
  return ` The thread that started this run is channel_id ${scope.thread.channelId}, thread_ts ${scope.thread.threadTimestamp}.`;
}

const searchInput = z.object({
  channel_id: z.string().min(1),
  limit: z.number().int().min(1).max(20).default(10),
  query: z.string().min(1).max(500),
});
const readChannelInput = z.object({
  channel_id: z.string().min(1),
  cursor: cursorSchema.optional(),
  latest: timestampSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
  oldest: timestampSchema.optional(),
});
const readThreadInput = z.object({
  channel_id: z.string().min(1),
  cursor: cursorSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  thread_ts: timestampSchema,
});
const postMessageInput = z.object({
  channel_id: z.string().min(1),
  text: z.string().trim().min(1).max(40_000),
  thread_ts: timestampSchema.optional(),
});
const addReactionInput = z.object({
  channel_id: z.string().min(1),
  name: z.string().trim().transform((value) => value.replace(/^:+|:+$/gu, ""))
    .pipe(z.string().regex(/^[a-z0-9_+'\-:]{1,100}$/u)),
  timestamp: timestampSchema,
});

export function slackToolDefinitions(scope: SlackToolScope) {
  const fullChannels = [...scope.channels.keys()];
  const allChannels = [
    ...new Set([...fullChannels, ...(scope.thread ? [scope.thread.channelId] : [])]),
  ];
  if (allChannels.length === 0) return [];
  const timestamp = { pattern: slackTimestampPattern.source, type: "string" };
  const channelTools = fullChannels.length === 0 ? [] : [
    {
      annotations: { readOnlyHint: true },
      description: "Search messages in a Slack channel from this connected workspace.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          channel_id: { enum: fullChannels, type: "string" },
          limit: { default: 10, maximum: 20, minimum: 1, type: "integer" },
          query: { maxLength: 500, minLength: 1, type: "string" },
        },
        required: ["channel_id", "query"],
        type: "object",
      },
      name: "slack_search_channel",
    },
    {
      annotations: { readOnlyHint: true },
      description: "Read the latest messages in a Slack channel, newest first. Thread replies are not included; use slack_read_thread for a message with replies. Pass nextCursor back as cursor to read older messages.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          channel_id: { enum: fullChannels, type: "string" },
          cursor: { maxLength: 500, minLength: 1, type: "string" },
          latest: { ...timestamp, description: "Only messages before this timestamp." },
          limit: { default: 20, maximum: 100, minimum: 1, type: "integer" },
          oldest: { ...timestamp, description: "Only messages after this timestamp." },
        },
        required: ["channel_id"],
        type: "object",
      },
      name: "slack_read_channel",
    },
  ];
  const onlyThread = fullChannels.length === 0;
  return [
    ...channelTools,
    {
      annotations: { readOnlyHint: true },
      description: `Read a Slack thread: its first message, then replies, oldest first.${onlyThread ? " Only the thread that started this run is available." : ""}${threadNote(scope)}`,
      inputSchema: {
        additionalProperties: false,
        properties: {
          channel_id: { enum: allChannels, type: "string" },
          cursor: { maxLength: 500, minLength: 1, type: "string" },
          limit: { default: 50, maximum: 200, minimum: 1, type: "integer" },
          thread_ts: timestamp,
        },
        required: ["channel_id", "thread_ts"],
        type: "object",
      },
      name: "slack_read_thread",
    },
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description: `Post a message to a Slack channel as the Responder app. Set thread_ts to reply in a thread. Uses Slack mrkdwn formatting.${onlyThread ? " Only replies in the thread that started this run are allowed." : ""}${threadNote(scope)}`,
      inputSchema: {
        additionalProperties: false,
        properties: {
          channel_id: { enum: allChannels, type: "string" },
          text: { maxLength: 40_000, minLength: 1, type: "string" },
          thread_ts: timestamp,
        },
        required: onlyThread ? ["channel_id", "text", "thread_ts"] : ["channel_id", "text"],
        type: "object",
      },
      name: "slack_post_message",
    },
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description: `Add an emoji reaction to a Slack message, for example "eyes" or "white_check_mark".${onlyThread ? " Only the message that started this run and its thread's first message are allowed." : ""}${scope.thread ? ` The message that started this run is channel_id ${scope.thread.channelId}, timestamp ${scope.thread.timestamp}.` : ""}`,
      inputSchema: {
        additionalProperties: false,
        properties: {
          channel_id: { enum: allChannels, type: "string" },
          name: { maxLength: 100, minLength: 1, type: "string" },
          timestamp,
        },
        required: ["channel_id", "timestamp", "name"],
        type: "object",
      },
      name: "slack_add_reaction",
    },
  ];
}

export type SlackToolResult = {
  content: Array<{ text: string; type: "text" }>;
  isError?: true;
};

function success(value: unknown): SlackToolResult {
  return { content: [{ text: JSON.stringify(value), type: "text" }] };
}

function failure(message: string): SlackToolResult {
  return { content: [{ text: message, type: "text" }], isError: true };
}

function credentials(claim: AutomationContextBrokerClaim) {
  if (!claim.account.encryptedCredentials) return null;
  return decryptCredentials<Record<string, unknown>>(
    claim.account.encryptedCredentials,
  );
}

function tokenFrom(
  values: Record<string, unknown> | null,
  key: "accessToken" | "userAccessToken",
): string | null {
  const value = values?.[key];
  return typeof value === "string" && value ? value : null;
}

const notAllowed = failure("This Slack channel or thread is not available to this automation.");

// Records a Slack write as an action attempt. A repeated call with the same
// arguments in one run returns the earlier result instead of writing again.
async function recordedWrite(input: {
  claim: AutomationContextBrokerClaim;
  dependencies: SlackToolDependencies;
  identity: unknown;
  kind: AutomationActionKind;
  redactedInput: Record<string, unknown>;
  toolName: string;
  write: (attemptId: string) => Promise<string>;
}): Promise<{ externalReference: string | null; repeated: boolean }> {
  const idempotencyKey = createHash("sha256")
    .update(`${input.claim.runId}\0${input.kind}\0${JSON.stringify(input.identity)}`, "utf8")
    .digest("hex");
  const attempt = await input.dependencies.beginAttempt({
    idempotencyKey,
    kind: input.kind,
    redactedInput: input.redactedInput,
    retryFailed: true,
    runId: input.claim.runId,
    toolCallId: input.toolName,
  });
  if (attempt.status === "existing_succeeded") {
    return { externalReference: attempt.externalReference, repeated: true };
  }
  let externalReference: string;
  try {
    externalReference = await input.write(attempt.id);
  } catch (error) {
    await input.dependencies.failAttempt({
      attemptId: attempt.id,
      failureMessage: error instanceof Error ? error.message.slice(0, 2_000) : "Action failed",
    });
    throw error;
  }
  await input.dependencies.completeAttempt({ attemptId: attempt.id, externalReference });
  await input.dependencies.appendEvent({
    data: { externalReference, kind: input.kind },
    runId: input.claim.runId,
    type: "action_succeeded",
  }).catch(() => undefined);
  return { externalReference, repeated: false };
}

async function runTool(
  claim: AutomationContextBrokerClaim,
  scope: SlackToolScope,
  name: string,
  args: unknown,
  signal: AbortSignal,
  dependencies: SlackToolDependencies,
): Promise<SlackToolResult> {
  const values = credentials(claim);
  const botToken = tokenFrom(values, "accessToken");
  if (name === "slack_search_channel") {
    const parsed = searchInput.safeParse(args);
    if (!parsed.success) return failure("Invalid tool arguments");
    const channelName = scope.channels.get(parsed.data.channel_id);
    if (channelName === undefined) return notAllowed;
    const userToken = tokenFrom(values, "userAccessToken");
    if (!userToken) return failure("Slack search is unavailable for this connection. Reconnect Slack to enable it.");
    return success(await dependencies.search({
      accessToken: userToken,
      channel: { id: parsed.data.channel_id, name: channelName },
      limit: parsed.data.limit,
      query: parsed.data.query,
      signal,
    }));
  }
  if (!botToken) return failure("Slack connection credentials are unavailable");
  if (name === "slack_read_channel") {
    const parsed = readChannelInput.safeParse(args);
    if (!parsed.success) return failure("Invalid tool arguments");
    if (!scope.channels.has(parsed.data.channel_id)) return notAllowed;
    return success(await dependencies.readChannel({
      accessToken: botToken,
      channelId: parsed.data.channel_id,
      cursor: parsed.data.cursor,
      latest: parsed.data.latest,
      limit: parsed.data.limit,
      oldest: parsed.data.oldest,
      signal,
    }));
  }
  if (name === "slack_read_thread") {
    const parsed = readThreadInput.safeParse(args);
    if (!parsed.success) return failure("Invalid tool arguments");
    if (
      !scope.channels.has(parsed.data.channel_id) &&
      !inTriggerThread(scope, parsed.data.channel_id, parsed.data.thread_ts)
    ) {
      return notAllowed;
    }
    return success(await dependencies.readThread({
      accessToken: botToken,
      channelId: parsed.data.channel_id,
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
      signal,
      threadTimestamp: parsed.data.thread_ts,
    }));
  }
  if (name === "slack_post_message") {
    const parsed = postMessageInput.safeParse(args);
    if (!parsed.success) return failure("Invalid tool arguments");
    const { channel_id: channelId, text, thread_ts: threadTimestamp } = parsed.data;
    if (
      !scope.channels.has(channelId) &&
      !inTriggerThread(scope, channelId, threadTimestamp)
    ) {
      return notAllowed;
    }
    const result = await recordedWrite({
      claim,
      dependencies,
      identity: [channelId, threadTimestamp ?? null, text],
      kind: "send_slack_message",
      redactedInput: { channelId, ...(threadTimestamp ? { threadTimestamp } : {}) },
      toolName: name,
      write: async (attemptId) => {
        const timestamp = await dependencies.postMessage({
          accessToken: botToken,
          channelId,
          clientMessageId: attemptId,
          text,
          ...(threadTimestamp ? { threadTimestamp } : {}),
        });
        return `${channelId}:${timestamp ?? "sent"}`;
      },
    });
    const timestamp = result.externalReference?.split(":")[1];
    return success({
      channelId,
      ...(timestamp && timestamp !== "sent" ? { timestamp } : {}),
      ...(threadTimestamp ? { threadTimestamp } : {}),
      ...(result.repeated ? { note: "This message was already posted in this run." } : {}),
    });
  }
  if (name === "slack_add_reaction") {
    const parsed = addReactionInput.safeParse(args);
    if (!parsed.success) return failure("Invalid tool arguments");
    const { channel_id: channelId, name: reaction, timestamp } = parsed.data;
    const triggerMessage = scope.thread?.channelId === channelId &&
      (scope.thread.timestamp === timestamp || scope.thread.threadTimestamp === timestamp);
    if (!scope.channels.has(channelId) && !triggerMessage) return notAllowed;
    await recordedWrite({
      claim,
      dependencies,
      identity: [channelId, timestamp, reaction],
      kind: "add_slack_reaction",
      redactedInput: { channelId, name: reaction, timestamp },
      toolName: name,
      write: async () => {
        await dependencies.addReaction({
          accessToken: botToken,
          channelId,
          name: reaction,
          timestamp,
        });
        return `${channelId}:${timestamp}:${reaction}`;
      },
    });
    return success({ channelId, name: reaction, timestamp });
  }
  throw new UnknownSlackToolError();
}

const slackToolNames = new Set([
  "slack_add_reaction",
  "slack_post_message",
  "slack_read_channel",
  "slack_read_thread",
  "slack_search_channel",
]);

export class UnknownSlackToolError extends Error {
  constructor() {
    super("Unknown Slack tool");
    this.name = "UnknownSlackToolError";
  }
}

// Slack API errors go back to the agent as tool errors so it can adjust.
export async function callSlackTool(input: {
  args: unknown;
  claim: AutomationContextBrokerClaim;
  dependencies: SlackToolDependencies;
  name: string;
  signal: AbortSignal;
}): Promise<SlackToolResult> {
  if (!slackToolNames.has(input.name)) throw new UnknownSlackToolError();
  const scope = slackToolScope(input.claim);
  try {
    return await runTool(
      input.claim,
      scope,
      input.name,
      input.args,
      input.signal,
      input.dependencies,
    );
  } catch (error) {
    if (error instanceof SlackApiError) {
      return failure(`Slack ${error.method} failed: ${error.code}`);
    }
    if (error instanceof AggregateError && error.errors.some((item) => item instanceof SlackApiError)) {
      return failure("Slack did not accept the message. Try again later.");
    }
    if (error instanceof Error && error.message === "Automation action has an unresolved prior attempt") {
      return failure("The same Slack call is still in progress.");
    }
    throw error;
  }
}
