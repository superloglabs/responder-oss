import { z } from "zod";
import {
  type PostHogApiHost,
  postHogApiHostSchema,
  type PostHogFetch,
  postHogAccount,
  postHogRequest,
} from "../../integrations/posthog-api.js";
import type { OtlpLogsRequest } from "./otlp-json.js";
import { rfc3339ToNanos } from "./otlp-json.js";
import { type PostHogLogLine, postHogLogsToOtlp } from "./posthog-logs.js";

// Reads the error lines of a PostHog project's logs every minute with the
// connection's OAuth token and sends them as OTLP. Error lines become error
// issues and Signal candidates; the rest of the project's logs stay in
// PostHog, where investigations read them. The cursor moves only past lines
// that were delivered.

// PostHog makes a line searchable some seconds after it arrives, so reads
// stop this far behind the present.
const LOG_VISIBILITY_LAG_MS = 60_000;
// A new source starts this far back, and a source that fell further behind
// skips ahead rather than replaying hours of logs.
const LOG_START_MS = 5 * 60_000;
const LOG_MAX_LAG_MS = 60 * 60_000;
// PostHog answers at most 2,000 lines a request. A window with more error
// lines than the pages hold keeps its newest.
const PAGE_SIZE = 1_000;
const MAX_PAGES = 10;
const ERROR_LEVELS = ["error", "fatal"];
// A project whose error lines stop still sends logs. Whether it does is read
// this often, so Signal knows the project's telemetry reaches Superlog. It
// is shorter than the 15 minutes after which the dashboard calls a source's
// data stale.
const ACTIVITY_EVERY_MS = 10 * 60_000;

export const postHogSourceStateSchema = z.object({
  activityReadAt: z.string().optional(),
  host: postHogApiHostSchema.optional(),
  logsCursor: z.string().optional(),
  organizationName: z.string().optional(),
  projectName: z.string().optional(),
});

export type PostHogSourceState = z.infer<typeof postHogSourceStateSchema>;

export type PostHogLogsForward = (payload: OtlpLogsRequest) => Promise<boolean>;

const pageSchema = z.object({
  hasMore: z.boolean().catch(false),
  nextCursor: z.string().nullish(),
  results: z.array(z.object({ timestamp: z.string(), uuid: z.string() }).passthrough()),
});

function startOf(cursor: string | undefined, now: Date): string {
  const floor = new Date(now.getTime() - LOG_MAX_LAG_MS);
  const parsed = cursor ? new Date(cursor) : new Date(now.getTime() - LOG_START_MS);
  return Number.isFinite(parsed.getTime()) && parsed > floor ? parsed.toISOString() : floor.toISOString();
}

function logsPath(projectId: string, action: "query"): string {
  return `/api/projects/${encodeURIComponent(projectId)}/logs/${action}/`;
}

/**
 * Reads the error lines in (start, end], newest page first, and returns them
 * oldest first. When a window holds more than MAX_PAGES pages, its oldest
 * lines are skipped and `truncated` says so.
 */
export async function readPostHogErrorWindow(input: {
  accessToken: string;
  end: string;
  fetch?: PostHogFetch;
  host: PostHogApiHost;
  projectId: string;
  start: string;
}): Promise<{ lines: PostHogLogLine[]; truncated: boolean }> {
  const startNanos = BigInt(rfc3339ToNanos(input.start));
  const endNanos = BigInt(rfc3339ToNanos(input.end));
  const seen = new Set<string>();
  const lines: PostHogLogLine[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = pageSchema.parse(await postHogRequest({
      accessToken: input.accessToken,
      body: {
        query: {
          dateRange: { date_from: input.start, date_to: input.end },
          limit: PAGE_SIZE,
          orderBy: "latest",
          severityLevels: ERROR_LEVELS,
          ...(after ? { after } : {}),
        },
      },
      host: input.host,
      path: logsPath(input.projectId, "query"),
      ...(input.fetch ? { fetch: input.fetch } : {}),
    }));
    for (const row of response.results) {
      const line = row as unknown as PostHogLogLine;
      const nanos = BigInt(rfc3339ToNanos(line.timestamp));
      if (nanos <= startNanos || nanos > endNanos || seen.has(line.uuid)) continue;
      seen.add(line.uuid);
      lines.push(line);
    }
    if (!response.hasMore || !response.nextCursor) return { lines: lines.reverse(), truncated: false };
    after = response.nextCursor;
  }
  return { lines: lines.reverse(), truncated: true };
}

// Whether the project received any log line in the last activity period.
async function projectSendsLogs(input: {
  accessToken: string;
  fetch?: PostHogFetch;
  host: PostHogApiHost;
  now: Date;
  projectId: string;
}): Promise<boolean> {
  const response = pageSchema.parse(await postHogRequest({
    accessToken: input.accessToken,
    body: {
      query: {
        dateRange: { date_from: new Date(input.now.getTime() - ACTIVITY_EVERY_MS).toISOString(), date_to: input.now.toISOString() },
        excludeAttributes: true,
        limit: 1,
      },
    },
    host: input.host,
    path: logsPath(input.projectId, "query"),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  }));
  return response.results.length > 0;
}

export async function pullPostHogSource(input: {
  accessToken: string;
  fetch?: PostHogFetch;
  forward: PostHogLogsForward;
  now?: Date;
  projectId: string;
  state: Record<string, unknown>;
}): Promise<{ error: string | null; logs: number; received: boolean; state: PostHogSourceState; truncated: boolean }> {
  const now = input.now ?? new Date();
  const parsed = postHogSourceStateSchema.safeParse(input.state);
  const state: PostHogSourceState = parsed.success ? { ...parsed.data } : {};
  const start = startOf(state.logsCursor, now);
  const end = new Date(now.getTime() - LOG_VISIBILITY_LAG_MS).toISOString();
  if (start >= end) return { error: null, logs: 0, received: false, state, truncated: false };
  const fetchOption = input.fetch ? { fetch: input.fetch } : {};
  try {
    state.host ??= (await postHogAccount({ accessToken: input.accessToken, ...fetchOption })).host;
    const host = state.host;
    const { lines, truncated } = await readPostHogErrorWindow({
      accessToken: input.accessToken,
      end,
      host,
      projectId: input.projectId,
      start,
      ...fetchOption,
    });
    const requests = postHogLogsToOtlp(
      lines,
      { projectId: input.projectId, ...(state.projectName ? { projectName: state.projectName } : {}) },
      { now },
    );
    for (const request of requests) {
      if (!(await input.forward(request))) throw new Error("Telemetry ingest did not accept the logs");
    }
    state.logsCursor = end;
    let active = lines.length > 0;
    if (!active && (!state.activityReadAt || now.getTime() - new Date(state.activityReadAt).getTime() >= ACTIVITY_EVERY_MS)) {
      state.activityReadAt = now.toISOString();
      active = await projectSendsLogs({ accessToken: input.accessToken, host, now, projectId: input.projectId, ...fetchOption })
        .catch(() => false);
    }
    return { error: null, logs: lines.length, received: active, state, truncated };
  } catch (error) {
    return {
      error: `Logs: ${error instanceof Error ? error.message : String(error)}`,
      logs: 0,
      received: false,
      state: parsed.success ? parsed.data : {},
      truncated: false,
    };
  }
}
