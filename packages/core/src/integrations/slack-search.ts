import { z } from "zod";
import { SlackApiError } from "./slack.js";

const slackSearchResponseSchema = z.object({
  ok: z.literal(true),
  messages: z.object({
    matches: z.array(
      z.object({
        channel: z.object({ id: z.string().min(1) }),
        permalink: z.string().url(),
        text: z.string(),
        ts: z.string().min(1),
        user: z.string().optional(),
        username: z.string().optional(),
      }),
    ),
  }),
});

const slackErrorResponseSchema = z.object({
  error: z.string().min(1).optional(),
  ok: z.literal(false),
});

const slackSearchModifier =
  /(?:^|\s)(?:after|before|during|from|has|in|is|on|to|with):\S+/iu;

export interface SlackSearchChannel {
  id: string;
  name: string;
}

export interface SlackSearchMatch {
  permalink: string;
  text: string;
  timestamp: string;
  userId?: string;
  username?: string;
}

export interface SlackChannelSearchResult {
  channel: SlackSearchChannel;
  matches: SlackSearchMatch[];
  query: string;
  totalMatches: number;
}

export class SlackSearchError extends SlackApiError {
  constructor(
    public readonly slackCode: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(
      "search.messages",
      slackCode,
      retryAfterSeconds === undefined
        ? []
        : [`retry_after=${retryAfterSeconds}`],
    );
    this.name = "SlackSearchError";
  }
}

export function normalizeSlackSearchQuery(query: string): string {
  const normalized = query.trim().replace(/\s+/gu, " ");
  if (!normalized) throw new Error("Slack search query is required");
  if (normalized.length > 500) {
    throw new Error("Slack search query must be at most 500 characters");
  }
  if (slackSearchModifier.test(normalized)) {
    throw new Error("Slack search modifiers are not allowed");
  }
  return normalized;
}

export async function searchSlackChannel(input: {
  accessToken: string;
  channel: SlackSearchChannel;
  query: string;
  limit: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<SlackChannelSearchResult> {
  const query = normalizeSlackSearchQuery(input.query);
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20) {
    throw new Error("Slack search limit must be between 1 and 20");
  }

  const url = new URL("https://slack.com/api/search.messages");
  url.searchParams.set("query", `${query} in:${input.channel.name}`);
  url.searchParams.set("count", String(input.limit));
  url.searchParams.set("sort", "timestamp");
  url.searchParams.set("sort_dir", "desc");

  const response = await (input.fetchImpl ?? fetch)(url, {
    headers: { authorization: `Bearer ${input.accessToken}` },
    signal: input.signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  const parsedError = slackErrorResponseSchema.safeParse(payload);
  if (!response.ok || parsedError.success) {
    const retryAfter = response.headers.get("retry-after");
    const retryAfterSeconds = retryAfter ? Number.parseInt(retryAfter, 10) : NaN;
    throw new SlackSearchError(
      parsedError.success
        ? (parsedError.data.error ?? "unknown_error")
        : `http_${response.status}`,
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    );
  }

  const page = slackSearchResponseSchema.parse(payload);
  const matches = page.messages.matches
    .filter((match) => match.channel.id === input.channel.id)
    .map((match) => ({
      permalink: match.permalink,
      text: match.text,
      timestamp: match.ts,
      ...(match.user ? { userId: match.user } : {}),
      ...(match.username ? { username: match.username } : {}),
    }));

  return {
    channel: input.channel,
    matches,
    query,
    totalMatches: matches.length,
  };
}
