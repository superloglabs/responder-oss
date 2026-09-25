import { z } from "zod";
import { SlackApiError } from "./slack.js";

// Reads channel and thread history with the bot token. Search needs the user
// token and Slack's search index; these calls return messages as they are.

const maximumMessageLength = 4_000;
export const slackTimestampPattern = /^\d{1,12}\.\d{1,8}$/u;

const slackMessageSchema = z.object({
  bot_id: z.string().optional(),
  reply_count: z.number().int().optional(),
  subtype: z.string().optional(),
  text: z.string().default(""),
  thread_ts: z.string().optional(),
  ts: z.string().min(1),
  user: z.string().optional(),
  username: z.string().optional(),
});

const slackHistoryResponseSchema = z.object({
  has_more: z.boolean().optional(),
  messages: z.array(slackMessageSchema),
  ok: z.literal(true),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});

const slackErrorResponseSchema = z.object({
  error: z.string().min(1).optional(),
  ok: z.literal(false),
});

export interface SlackHistoryMessage {
  botId?: string;
  replyCount?: number;
  subtype?: string;
  text: string;
  threadTimestamp?: string;
  timestamp: string;
  truncated?: true;
  userId?: string;
  username?: string;
}

export interface SlackHistoryPage {
  channelId: string;
  messages: SlackHistoryMessage[];
  nextCursor?: string;
}

function message(value: z.infer<typeof slackMessageSchema>): SlackHistoryMessage {
  const truncated = value.text.length > maximumMessageLength;
  return {
    ...(value.bot_id ? { botId: value.bot_id } : {}),
    ...(value.reply_count ? { replyCount: value.reply_count } : {}),
    ...(value.subtype ? { subtype: value.subtype } : {}),
    text: truncated ? `${value.text.slice(0, maximumMessageLength)}…` : value.text,
    ...(value.thread_ts ? { threadTimestamp: value.thread_ts } : {}),
    timestamp: value.ts,
    ...(truncated ? { truncated: true as const } : {}),
    ...(value.user ? { userId: value.user } : {}),
    ...(value.username ? { username: value.username } : {}),
  };
}

function assertLimit(limit: number, maximum: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`Slack history limit must be between 1 and ${maximum}`);
  }
}

function assertTimestamp(value: string | undefined, name: string): void {
  if (value !== undefined && !slackTimestampPattern.test(value)) {
    throw new Error(`Slack ${name} must be a message timestamp`);
  }
}

async function readHistory(input: {
  accessToken: string;
  channelId: string;
  fetchImpl?: typeof fetch;
  method: "conversations.history" | "conversations.replies";
  params: Record<string, string | undefined>;
  signal?: AbortSignal;
}): Promise<SlackHistoryPage> {
  const url = new URL(`https://slack.com/api/${input.method}`);
  url.searchParams.set("channel", input.channelId);
  for (const [name, value] of Object.entries(input.params)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  const response = await (input.fetchImpl ?? fetch)(url, {
    headers: { authorization: `Bearer ${input.accessToken}` },
    signal: input.signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  const parsedError = slackErrorResponseSchema.safeParse(payload);
  if (!response.ok || parsedError.success) {
    throw new SlackApiError(
      input.method,
      parsedError.success
        ? (parsedError.data.error ?? "unknown_error")
        : `http_${response.status}`,
    );
  }
  const page = slackHistoryResponseSchema.parse(payload);
  const nextCursor = page.has_more ? page.response_metadata?.next_cursor : undefined;
  return {
    channelId: input.channelId,
    messages: page.messages.map(message),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

// Newest messages first. Replies inside threads are not included; read the
// thread for those.
export async function readSlackChannelHistory(input: {
  accessToken: string;
  channelId: string;
  cursor?: string;
  fetchImpl?: typeof fetch;
  latest?: string;
  limit: number;
  oldest?: string;
  signal?: AbortSignal;
}): Promise<SlackHistoryPage> {
  assertLimit(input.limit, 100);
  assertTimestamp(input.oldest, "oldest");
  assertTimestamp(input.latest, "latest");
  return readHistory({
    accessToken: input.accessToken,
    channelId: input.channelId,
    fetchImpl: input.fetchImpl,
    method: "conversations.history",
    params: {
      cursor: input.cursor,
      latest: input.latest,
      limit: String(input.limit),
      oldest: input.oldest,
    },
    signal: input.signal,
  });
}

// The thread's first message, then its replies, oldest first.
export async function readSlackThread(input: {
  accessToken: string;
  channelId: string;
  cursor?: string;
  fetchImpl?: typeof fetch;
  limit: number;
  signal?: AbortSignal;
  threadTimestamp: string;
}): Promise<SlackHistoryPage> {
  assertLimit(input.limit, 200);
  assertTimestamp(input.threadTimestamp, "thread timestamp");
  return readHistory({
    accessToken: input.accessToken,
    channelId: input.channelId,
    fetchImpl: input.fetchImpl,
    method: "conversations.replies",
    params: {
      cursor: input.cursor,
      limit: String(input.limit),
      ts: input.threadTimestamp,
    },
    signal: input.signal,
  });
}
