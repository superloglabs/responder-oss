import { z } from "zod";
import { decryptCredentials } from "@responder/core/credentials/encryption";
import { getSlackThreadSessionContext } from "@responder/core/db/investigations";
import { getSlackInvestigationLiveContext } from "@responder/core/db/issues";
import {
  readSlackThread,
  type SlackHistoryMessage,
} from "@responder/core/integrations/slack-history";

// A tag in a thread arrives as the tagging message alone. The agent reads the
// thread's earlier messages here, so "look at this" points at the alert above.

const slackCredentialsSchema = z.object({
  accessToken: z.string().min(1),
});

const threadPageLimit = 200;
// Slack returns a thread oldest first, so the read pages to its end. This
// bounds a runaway thread at 10,000 messages.
const maximumThreadPages = 50;
const threadReadTimeoutMs = 15_000;
export const maximumThreadContextMessages = 50;
export const maximumThreadContextLength = 30_000;

// Slack timestamps are seconds and microseconds; compare them as integers so
// the comparison never loses precision.
function slackTimestampValue(timestamp: string): bigint {
  const [seconds = "0", fraction = ""] = timestamp.split(".");
  return BigInt(seconds) * 1_000_000n + BigInt(fraction.padEnd(6, "0").slice(0, 6));
}

function isBefore(left: string, right: string): boolean {
  return slackTimestampValue(left) < slackTimestampValue(right);
}

// The thread messages before the current one that the session has not seen:
// after the newest message a finished turn read, and not posted by the
// session itself.
export function unseenSlackThreadMessages(input: {
  currentTimestamp: string;
  messages: SlackHistoryMessage[];
  postedTimestamps: string[];
  readThrough: string | null;
}): SlackHistoryMessage[] {
  const posted = new Set(input.postedTimestamps);
  return input.messages.filter((message) =>
    isBefore(message.timestamp, input.currentTimestamp) &&
    (!input.readThrough || isBefore(input.readThrough, message.timestamp)) &&
    !posted.has(message.timestamp)
  );
}

function author(message: SlackHistoryMessage): string {
  if (message.username) return message.username;
  if (message.userId && !message.botId) return `<@${message.userId}>`;
  return "An app";
}

function messageTime(timestamp: string): string {
  const milliseconds = Number(slackTimestampValue(timestamp) / 1_000n);
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function formatMessage(message: SlackHistoryMessage): string {
  return `[${messageTime(message.timestamp)}] ${author(message)}: ${message.text.trim() || "(no text)"}`;
}

// Keeps the thread's first message, which is usually the alert, and as many of
// the newest messages as fit. `omitted` counts messages already dropped from
// the middle of the thread before formatting.
export function formatSlackThreadContext(input: {
  messages: SlackHistoryMessage[];
  omitted?: number;
  threadTimestamp: string;
}): string | null {
  if (input.messages.length === 0) return null;
  const [first, ...rest] = input.messages;
  const parent = first!.timestamp === input.threadTimestamp ? formatMessage(first!) : null;
  const candidates = (parent ? rest : input.messages).map(formatMessage);
  let length = parent?.length ?? 0;
  const kept: string[] = [];
  for (const line of candidates.reverse()) {
    if (
      kept.length + (parent ? 1 : 0) >= maximumThreadContextMessages ||
      length + line.length > maximumThreadContextLength
    ) {
      break;
    }
    kept.unshift(line);
    length += line.length;
  }
  const omitted = (input.omitted ?? 0) + candidates.length - kept.length;
  return [
    "# Earlier messages in this Slack thread",
    "",
    "Oldest first. The request below is the newest message in the thread.",
    "",
    ...(parent ? [parent] : []),
    ...(omitted > 0 ? [`(${omitted} more ${omitted === 1 ? "message" : "messages"} omitted)`] : []),
    ...kept,
  ].join("\n");
}

export interface SlackThreadContextDependencies {
  getLiveContext: typeof getSlackInvestigationLiveContext;
  getSessionContext: typeof getSlackThreadSessionContext;
  readThread: typeof readSlackThread;
}

const defaultDependencies: SlackThreadContextDependencies = {
  getLiveContext: getSlackInvestigationLiveContext,
  getSessionContext: getSlackThreadSessionContext,
  readThread: readSlackThread,
};

export interface SlackThreadContext {
  // The earlier messages to put before the request, if any are new.
  context: string | null;
  // The message the turn has read the thread up to. The session stores it
  // when the turn finishes, so a failed read is read again next turn.
  readThrough: string;
}

// Returns null when the thread cannot be read; the turn then answers from the
// message alone.
export async function loadSlackThreadContext(
  input: { investigationId: string; sessionId: string },
  dependencies: SlackThreadContextDependencies = defaultDependencies,
): Promise<SlackThreadContext | null> {
  try {
    const context = await dependencies.getLiveContext(input.investigationId);
    const currentTimestamp = context?.source.reactionTimestamp;
    if (!context || !currentTimestamp) return null;
    const { threadTimestamp } = context.source;
    if (currentTimestamp === threadTimestamp) {
      return { context: null, readThrough: currentTimestamp };
    }
    const { accessToken } = slackCredentialsSchema.parse(
      decryptCredentials<Record<string, unknown>>(context.source.encryptedCredentials),
    );
    const session = await dependencies.getSessionContext(input);
    const signal = AbortSignal.timeout(threadReadTimeoutMs);
    // Holds the thread's first message and a window of the newest ones, so a
    // long thread is never held in memory whole.
    let parent: SlackHistoryMessage | null = null;
    let newest: SlackHistoryMessage[] = [];
    let omitted = 0;
    let cursor: string | undefined;
    for (let page = 0; page < maximumThreadPages; page += 1) {
      const result = await dependencies.readThread({
        accessToken,
        channelId: context.source.channelId,
        cursor,
        limit: threadPageLimit,
        signal,
        threadTimestamp,
      });
      for (const message of unseenSlackThreadMessages({
        currentTimestamp,
        messages: result.messages,
        postedTimestamps: session.postedTimestamps,
        readThrough: session.readThrough,
      })) {
        if (!parent && newest.length === 0 && message.timestamp === threadTimestamp) {
          parent = message;
        } else {
          newest.push(message);
        }
      }
      if (newest.length > maximumThreadContextMessages) {
        omitted += newest.length - maximumThreadContextMessages;
        newest = newest.slice(-maximumThreadContextMessages);
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return {
      context: formatSlackThreadContext({
        messages: parent ? [parent, ...newest] : newest,
        omitted,
        threadTimestamp,
      }),
      readThrough: currentTimestamp,
    };
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : undefined,
      event: "slack_thread_context_failed",
      investigationId: input.investigationId,
    }));
    return null;
  }
}
