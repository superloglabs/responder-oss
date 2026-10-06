import { z } from "zod";
import { SlackApiError } from "./slack.js";
import { slackAttachmentsSchema, slackMessageText } from "./slack-history.js";

const slackSearchResponseSchema = z.object({
  ok: z.literal(true),
  messages: z.object({
    matches: z.array(
      z.object({
        attachments: slackAttachmentsSchema,
        channel: z.object({ id: z.string().min(1), name: z.string().optional() }),
        permalink: z.string().url(),
        text: z.string().default(""),
        ts: z.string().min(1),
        user: z.string().optional(),
        username: z.string().optional(),
      }),
    ),
    paging: z
      .object({
        page: z.number().int().optional(),
        pages: z.number().int().optional(),
        total: z.number().int().optional(),
      })
      .optional(),
  }),
});

const slackErrorResponseSchema = z.object({
  error: z.string().min(1).optional(),
  ok: z.literal(false),
});

// The caller owns the channel constraint, so only `in:` is refused. Other
// modifiers such as `from:`, `after:`, and `has:` only narrow the results.
const slackChannelModifier = /(?:^|\s)in:\S+/iu;

export const slackSearchSorts = ["timestamp", "score"] as const;
export type SlackSearchSort = (typeof slackSearchSorts)[number];

export interface SlackSearchChannel {
  id: string;
  name: string;
}

export interface SlackSearchMatch {
  permalink: string;
  text: string;
  threadTimestamp?: string;
  timestamp: string;
  truncated?: true;
  userId?: string;
  username?: string;
}

export interface SlackSearchPaging {
  page: number;
  pageCount: number;
  // Matches in the searched channels across every page.
  total: number;
}

export interface SlackChannelSearchResult extends SlackSearchPaging {
  channel: SlackSearchChannel;
  matches: SlackSearchMatch[];
  query: string;
  totalMatches: number;
}

export interface SlackChannelsSearchResult extends SlackSearchPaging {
  matches: Array<SlackSearchMatch & { channel: SlackSearchChannel }>;
  query: string;
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
  if (slackChannelModifier.test(normalized)) {
    throw new Error("The Slack in: modifier is not allowed; choose the channel instead");
  }
  return normalized;
}

function threadTimestamp(permalink: string, timestamp: string): string | undefined {
  const value = new URL(permalink).searchParams.get("thread_ts");
  return value && value !== timestamp ? value : undefined;
}

interface SearchPage extends SlackSearchPaging {
  matches: Array<{ channel: SlackSearchChannel; match: SlackSearchMatch }>;
  query: string;
}

// Slack ORs repeated in: modifiers, and each one adds to the query, so one
// search covers a bounded number of channels.
export const maxSlackSearchChannels = 50;

// Searches as the connecting user, whose index also covers their direct
// messages and other channels. The in: modifiers make Slack search, count,
// and page only `channels`, so the totals reveal nothing about other
// conversations. Matches are still filtered by channel ID.
async function searchMessages(input: {
  accessToken: string;
  channels: readonly SlackSearchChannel[];
  fetchImpl?: typeof fetch;
  limit: number;
  page?: number;
  query: string;
  signal?: AbortSignal;
  sort?: SlackSearchSort;
}): Promise<SearchPage> {
  const query = normalizeSlackSearchQuery(input.query);
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error("Slack search limit must be between 1 and 100");
  }
  const page = input.page ?? 1;
  if (!Number.isInteger(page) || page < 1 || page > 100) {
    throw new Error("Slack search page must be between 1 and 100");
  }
  const channelsById = new Map(input.channels.map((channel) => [channel.id, channel]));
  if (channelsById.size === 0) throw new Error("Slack search needs at least one channel");
  if (channelsById.size > maxSlackSearchChannels) {
    throw new Error(`Slack search covers at most ${maxSlackSearchChannels} channels at once`);
  }

  const url = new URL("https://slack.com/api/search.messages");
  const scope = [...channelsById.values()].map((channel) => `in:${channel.name}`);
  url.searchParams.set("query", [query, ...scope].join(" "));
  url.searchParams.set("count", String(input.limit));
  url.searchParams.set("page", String(page));
  url.searchParams.set("sort", input.sort ?? "timestamp");
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

  const result = slackSearchResponseSchema.parse(payload);
  const matches = result.messages.matches.flatMap((match) => {
    const channel = channelsById.get(match.channel.id);
    if (!channel) return [];
    const { text, truncated } = slackMessageText(match.text, match.attachments);
    const thread = threadTimestamp(match.permalink, match.ts);
    return [{
      channel,
      match: {
        permalink: match.permalink,
        text,
        ...(thread ? { threadTimestamp: thread } : {}),
        timestamp: match.ts,
        ...(truncated ? { truncated } : {}),
        ...(match.user ? { userId: match.user } : {}),
        ...(match.username ? { username: match.username } : {}),
      },
    }];
  });
  const paging = result.messages.paging;
  return {
    matches,
    page: paging?.page ?? page,
    pageCount: paging?.pages ?? page,
    query,
    total: paging?.total ?? matches.length,
  };
}

export async function searchSlackChannel(input: {
  accessToken: string;
  channel: SlackSearchChannel;
  query: string;
  limit: number;
  page?: number;
  signal?: AbortSignal;
  sort?: SlackSearchSort;
  fetchImpl?: typeof fetch;
}): Promise<SlackChannelSearchResult> {
  const { channel, ...rest } = input;
  const result = await searchMessages({ ...rest, channels: [channel] });
  return {
    channel,
    matches: result.matches.map(({ match }) => match),
    page: result.page,
    pageCount: result.pageCount,
    query: result.query,
    total: result.total,
    totalMatches: result.matches.length,
  };
}

// One search across up to `maxSlackSearchChannels` channels.
export async function searchSlackChannels(input: {
  accessToken: string;
  channels: readonly SlackSearchChannel[];
  query: string;
  limit: number;
  page?: number;
  signal?: AbortSignal;
  sort?: SlackSearchSort;
  fetchImpl?: typeof fetch;
}): Promise<SlackChannelsSearchResult> {
  const result = await searchMessages(input);
  return {
    ...result,
    matches: result.matches.map(({ channel, match }) => ({ channel, ...match })),
  };
}
