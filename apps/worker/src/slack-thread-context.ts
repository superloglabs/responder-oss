import { z } from "zod";
import { decryptCredentials } from "@responder/core/credentials/encryption";
import {
  getSlackThreadSessionTurns,
  type SlackThreadSessionTurn,
} from "@responder/core/db/investigations";
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
const maximumThreadPages = 5;
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

// The thread messages before the current one that no earlier turn of the
// session answered or posted. A later turn sees only what arrived since the
// previous turn.
export function unseenSlackThreadMessages(input: {
  currentTimestamp: string;
  messages: SlackHistoryMessage[];
  turns: SlackThreadSessionTurn[];
}): SlackHistoryMessage[] {
  const posted = new Set(input.turns.flatMap((turn) => turn.postedTimestamps));
  const answered = input.turns
    .map((turn) => turn.messageTimestamp)
    .filter((timestamp): timestamp is string =>
      Boolean(timestamp) && isBefore(timestamp!, input.currentTimestamp)
    )
    .reduce<string | null>(
      (latest, timestamp) => !latest || isBefore(latest, timestamp) ? timestamp : latest,
      null,
    );
  return input.messages.filter((message) =>
    isBefore(message.timestamp, input.currentTimestamp) &&
    (!answered || isBefore(answered, message.timestamp)) &&
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
// the newest messages as fit.
export function formatSlackThreadContext(input: {
  messages: SlackHistoryMessage[];
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
  const omitted = candidates.length - kept.length;
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
  getTurns: typeof getSlackThreadSessionTurns;
  readThread: typeof readSlackThread;
}

const defaultDependencies: SlackThreadContextDependencies = {
  getLiveContext: getSlackInvestigationLiveContext,
  getTurns: getSlackThreadSessionTurns,
  readThread: readSlackThread,
};

// Returns null for a message that starts its thread, or when the thread cannot
// be read. The turn then answers from the message alone.
export async function loadSlackThreadContext(
  input: { investigationId: string; sessionId: string },
  dependencies: SlackThreadContextDependencies = defaultDependencies,
): Promise<string | null> {
  try {
    const context = await dependencies.getLiveContext(input.investigationId);
    const currentTimestamp = context?.source.reactionTimestamp;
    if (!context || !currentTimestamp || currentTimestamp === context.source.threadTimestamp) {
      return null;
    }
    const { accessToken } = slackCredentialsSchema.parse(
      decryptCredentials<Record<string, unknown>>(context.source.encryptedCredentials),
    );
    const messages: SlackHistoryMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maximumThreadPages; page += 1) {
      const result = await dependencies.readThread({
        accessToken,
        channelId: context.source.channelId,
        cursor,
        limit: threadPageLimit,
        threadTimestamp: context.source.threadTimestamp,
      });
      messages.push(...result.messages);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    const turns = await dependencies.getTurns(input);
    return formatSlackThreadContext({
      messages: unseenSlackThreadMessages({ currentTimestamp, messages, turns }),
      threadTimestamp: context.source.threadTimestamp,
    });
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
