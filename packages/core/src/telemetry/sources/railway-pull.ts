import { z } from "zod";
import { type RailwayFetch, railwayGraphql, railwayProjectServiceNames } from "../../integrations/railway.js";
import { rfc3339ToNanos } from "./otlp-json.js";
import { type RailwayLogLine, railwayLogBlocks, railwayLogsToOtlp } from "./railway-logs.js";
import type { OtlpLogsRequest } from "./otlp-json.js";

// Reads a Railway environment's runtime logs every minute with the
// connection's OAuth token and sends them as OTLP. Railway has no log drains,
// so its logs API is the only way to receive them. The cursor moves only past
// logs that were delivered.

// Railway makes a log readable a few seconds after it is written, so reads
// stop this far behind the present.
const LOG_VISIBILITY_LAG_MS = 20_000;
// A new source starts this far back, and a source that fell further behind
// skips ahead rather than replaying hours of logs.
const LOG_START_MS = 5 * 60_000;
const LOG_MAX_LAG_MS = 60 * 60_000;
// Railway answers at most 5,000 logs a request. Smaller pages keep each
// response small; a window with more logs is read newest page first.
const PAGE_SIZE = 1_000;
const MAX_PAGES = 10;
const MAX_RESPONSE_BYTES = 10_000_000;
// Service names are read again this often, and whenever a log names a
// service the source does not know yet.
const SERVICES_EVERY_MS = 60 * 60_000;

export const railwaySourceStateSchema = z.object({
  environmentName: z.string().optional(),
  logsCursor: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  services: z.record(z.string(), z.string()).default({}),
  servicesReadAt: z.string().optional(),
  workspaceId: z.string().optional(),
});

export type RailwaySourceState = z.infer<typeof railwaySourceStateSchema>;

export type RailwayLogsForward = (payload: OtlpLogsRequest) => Promise<boolean>;

const logFields = "timestamp severity message attributes { key value } tags { serviceId deploymentId deploymentInstanceId projectId }";

// The newest logs in (start, anchor], oldest first. Railway reads the window
// to the millisecond and returns one log more than asked, so callers filter
// by exact time.
const windowQuery = `query ($environmentId: String!, $start: String!, $anchor: String!, $limit: Int!) {
  logs: environmentLogs(environmentId: $environmentId, beforeDate: $start, anchorDate: $anchor, afterDate: $anchor, beforeLimit: $limit, afterLimit: 0) { ${logFields} }
}`;

function startOf(cursor: string | undefined, now: Date): string {
  const floor = new Date(now.getTime() - LOG_MAX_LAG_MS);
  const parsed = cursor ? new Date(cursor) : new Date(now.getTime() - LOG_START_MS);
  return Number.isFinite(parsed.getTime()) && parsed > floor ? parsed.toISOString() : floor.toISOString();
}

/**
 * Reads every log in (start, end]. Pages go back from the end; when a window
 * holds more than MAX_PAGES pages, its oldest logs are skipped and
 * `truncated` says so.
 */
export async function readRailwayLogWindow(input: {
  accessToken: string;
  end: string;
  environmentId: string;
  fetch?: RailwayFetch;
  start: string;
}): Promise<{ lines: RailwayLogLine[]; truncated: boolean }> {
  const startNanos = BigInt(rfc3339ToNanos(input.start));
  const endNanos = BigInt(rfc3339ToNanos(input.end));
  const seen = new Set<string>();
  const lines: RailwayLogLine[] = [];
  let anchor = input.end;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await railwayGraphql<{ logs: RailwayLogLine[] | null }>({
      accessToken: input.accessToken,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      query: windowQuery,
      variables: { anchor, environmentId: input.environmentId, limit: PAGE_SIZE, start: input.start },
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
    const logs = (data.logs ?? []).slice(-PAGE_SIZE);
    for (const log of logs) {
      const nanos = BigInt(rfc3339ToNanos(log.timestamp));
      if (nanos <= startNanos || nanos > endNanos) continue;
      // Pages overlap at their edges, where they share a millisecond.
      const key = `${log.timestamp}\u0000${log.tags?.deploymentInstanceId ?? ""}\u0000${log.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(log);
    }
    const earliest = logs[0]?.timestamp;
    if (logs.length < PAGE_SIZE || !earliest || BigInt(rfc3339ToNanos(earliest)) <= startNanos) {
      return { lines, truncated: false };
    }
    // The next page ends at this page's oldest log.
    anchor = earliest;
  }
  return { lines, truncated: true };
}

export async function pullRailwaySource(input: {
  accessToken: string;
  environmentId: string;
  fetch?: RailwayFetch;
  forward: RailwayLogsForward;
  now?: Date;
  state: Record<string, unknown>;
}): Promise<{ error: string | null; logs: number; received: boolean; state: RailwaySourceState; truncated: boolean }> {
  const now = input.now ?? new Date();
  const parsed = railwaySourceStateSchema.safeParse(input.state);
  const state: RailwaySourceState = parsed.success ? { ...parsed.data } : { services: {} };
  const start = startOf(state.logsCursor, now);
  const end = new Date(now.getTime() - LOG_VISIBILITY_LAG_MS).toISOString();
  if (start >= end) return { error: null, logs: 0, received: false, state, truncated: false };
  try {
    const { lines, truncated } = await readRailwayLogWindow({
      accessToken: input.accessToken,
      end,
      environmentId: input.environmentId,
      start,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
    const projectId = state.projectId ?? lines.find((line) => line.tags?.projectId)?.tags?.projectId ?? undefined;
    const unknown = lines.some((line) => line.tags?.serviceId && !state.services[line.tags.serviceId]);
    const stale = !state.servicesReadAt || now.getTime() - new Date(state.servicesReadAt).getTime() >= SERVICES_EVERY_MS;
    if (projectId && lines.length > 0 && (unknown || stale)) {
      // Without names, logs carry the service ID as their service.
      try {
        state.services = await railwayProjectServiceNames({
          accessToken: input.accessToken,
          projectId,
          ...(input.fetch ? { fetch: input.fetch } : {}),
        });
      } catch {
        // Kept from the last read.
      }
      state.servicesReadAt = now.toISOString();
    }
    const blocks = railwayLogBlocks(lines);
    const requests = railwayLogsToOtlp(
      blocks,
      {
        environmentId: input.environmentId,
        services: state.services,
        ...(state.environmentName ? { environmentName: state.environmentName } : {}),
        ...(projectId ? { projectId } : {}),
        ...(state.projectName ? { projectName: state.projectName } : {}),
      },
      { now },
    );
    for (const request of requests) {
      if (!(await input.forward(request))) throw new Error("Telemetry ingest did not accept the logs");
    }
    state.logsCursor = end;
    return { error: null, logs: blocks.length, received: blocks.length > 0, state, truncated };
  } catch (error) {
    return {
      error: `Logs: ${error instanceof Error ? error.message : String(error)}`,
      logs: 0,
      received: false,
      state: parsed.success ? parsed.data : { services: {} },
      truncated: false,
    };
  }
}
