import { z } from "zod";
import {
  RenderApiError,
  type RenderFetch,
  type RenderLogLine,
  renderLogsPage,
  type RenderService,
  renderServices,
} from "../../integrations/render.js";
import type { OtlpLogsRequest } from "./otlp-json.js";
import { rfc3339ToNanos } from "./otlp-json.js";
import { renderLabel, renderLogBlocks, renderLogsToOtlp, type RenderServiceInfo } from "./render-logs.js";

// Reads the logs of the Render services and workspaces one API key's
// connection chose, every minute, and sends them as OTLP. Render's logs API
// allows 30 requests a minute per user, so one pass spends at most
// `pageBudget` requests for the whole connection, split across its reads. A
// read covers the services that share a workspace and a region, as Render
// requires. Pages are read forward from each source's cursor; a pass that
// runs out of budget, or meets a failed page, keeps the pages it read and
// the next pass continues after them.

// Render makes a log readable a few seconds after it is written, so reads
// stop this far behind the present.
const LOG_VISIBILITY_LAG_MS = 20_000;
// A new source starts this far back, and a source that fell further behind
// skips ahead rather than replaying hours of logs.
const LOG_START_MS = 5 * 60_000;
const LOG_MAX_LAG_MS = 60 * 60_000;
// 24 pages of 100 lines read 2,400 lines a minute and leave room under
// Render's 30 log requests a minute for the key's other uses.
export const RENDER_PAGE_BUDGET = 24;
const PAGE_SIZE = 100;
// Services one read names, so its URL stays short.
const RESOURCES_PER_READ = 50;
// Line IDs kept at the cursor's timestamp.
const MAX_CURSOR_IDS = 1_000;

const cursorSchema = z.object({ ids: z.array(z.string()).default([]), ts: z.string() });
type Cursor = z.infer<typeof cursorSchema>;

const serviceInfoSchema = z.object({
  name: z.string(),
  region: z.string().nullable().optional(),
  type: z.string().optional(),
});

// A source reads one service, or every service in a workspace. Its external
// ID is the service ID or the workspace ID. Each service keeps its own
// cursor, so services read in different parts never send a line twice.
export const renderSourceStateSchema = z.object({
  cursors: z.record(z.string(), cursorSchema).default({}),
  kind: z.enum(["service", "workspace"]),
  ownerId: z.string().min(1),
  region: z.string().nullable().optional(),
  serviceName: z.string().optional(),
  serviceType: z.string().optional(),
  // A workspace's services, as last listed.
  services: z.record(z.string(), serviceInfoSchema).default({}),
  workspaceName: z.string().optional(),
});

export type RenderSourceState = z.infer<typeof renderSourceStateSchema>;

export type RenderLogsForward = (payload: OtlpLogsRequest) => Promise<boolean>;

export interface RenderPullSource {
  externalId: string;
  id: string;
  state: Record<string, unknown>;
}

export interface RenderSourceResult {
  error: string | null;
  logs: number;
  received: boolean;
  state: Record<string, unknown>;
  // Logs were skipped: a service fell more than an hour behind.
  truncated: boolean;
}

export interface RenderAccountResult {
  // Reads that still had logs when the budget ran out.
  behind: boolean;
  pages: number;
  // Render limited the reads or could not serve logs; the next pass reads again.
  retryLater: boolean;
  sources: Map<string, RenderSourceResult>;
}

export const renderRefusedKey = "Render refused the API key. Connect Render again with a new key.";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nanos(timestamp: string): bigint {
  return BigInt(rfc3339ToNanos(timestamp));
}

// Whether the line was sent before: at or before the cursor's time, unless
// it shares that time and was not among the lines sent then. A line at that
// time without an ID cannot be told apart, so it counts as sent.
export function sentBefore(cursor: Cursor | undefined, line: Pick<RenderLogLine, "id" | "timestamp">): boolean {
  if (!cursor) return false;
  const at = nanos(line.timestamp);
  const until = nanos(cursor.ts);
  if (at < until) return true;
  if (at > until) return false;
  return !line.id || cursor.ids.includes(line.id);
}

// The cursor after reading through `until`, never moving back.
export function advanceCursor(cursor: Cursor | undefined, until: string, lines: Array<Pick<RenderLogLine, "id" | "timestamp">>): Cursor {
  if (cursor && nanos(cursor.ts) > nanos(until)) return cursor;
  const kept = cursor && nanos(cursor.ts) === nanos(until) ? cursor.ids : [];
  const ids = new Set(kept);
  for (const line of lines) {
    if (line.id && nanos(line.timestamp) === nanos(until)) ids.add(line.id);
  }
  return { ids: [...ids].slice(-MAX_CURSOR_IDS), ts: until };
}

type Member = { error: string | null; logs: number; skipped: boolean; source: RenderPullSource; state: RenderSourceState };

// One service in a read: the source it belongs to, and its cursor.
type Covered = { cursor: Cursor; info: RenderServiceInfo; member: Member; serviceId: string };

/**
 * Reads one connection's sources once. Every source gets a result; a
 * service's cursor moves only past logs that were delivered.
 */
export async function pullRenderAccount(input: {
  apiKey: string;
  fetch?: RenderFetch;
  forward: RenderLogsForward;
  now?: Date;
  pageBudget?: number;
  sources: RenderPullSource[];
}): Promise<RenderAccountResult> {
  const now = input.now ?? new Date();
  const fetchOption = input.fetch ? { fetch: input.fetch } : {};
  const results = new Map<string, RenderSourceResult>();
  const outcome: RenderAccountResult = { behind: false, pages: 0, retryLater: false, sources: results };
  const refuse = () => {
    for (const source of input.sources) {
      results.set(source.id, { error: renderRefusedKey, logs: 0, received: false, state: source.state, truncated: false });
    }
    return outcome;
  };

  const end = new Date(now.getTime() - LOG_VISIBILITY_LAG_MS).toISOString();
  const floor = new Date(now.getTime() - LOG_MAX_LAG_MS).toISOString();
  const fresh = new Date(now.getTime() - LOG_START_MS).toISOString();
  const members: Member[] = [];
  for (const source of input.sources) {
    const parsed = renderSourceStateSchema.safeParse(source.state);
    if (parsed.success) {
      members.push({ error: null, logs: 0, skipped: false, source, state: parsed.data });
    } else {
      results.set(source.id, {
        error: "This source's settings are incomplete. Remove it and add it again.",
        logs: 0,
        received: false,
        state: source.state,
        truncated: false,
      });
    }
  }

  // Each workspace's services, listed once a pass. A workspace that cannot
  // be listed keeps the services last listed.
  const listed = new Map<string, RenderService[] | null>();
  for (const ownerId of new Set(members.map((member) => member.state.ownerId))) {
    try {
      listed.set(ownerId, await renderServices({ apiKey: input.apiKey, ownerId, ...fetchOption }));
    } catch (error) {
      if (error instanceof RenderApiError && error.kind === "unauthorized") return refuse();
      listed.set(ownerId, null);
    }
  }

  // A service with a source of its own belongs to it; the others belong to
  // their workspace's source. Services that share a workspace and region are
  // read together.
  const own = new Set(members.filter((member) => member.state.kind === "service").map((member) => member.source.externalId));
  const groups = new Map<string, Covered[]>();
  function cover(member: Member, serviceId: string, info: RenderServiceInfo) {
    let cursor = member.state.cursors[serviceId];
    if (!cursor) {
      // A new service starts a few minutes back, even if this pass cannot
      // read it.
      cursor = { ids: [], ts: fresh };
    } else if (nanos(cursor.ts) < nanos(floor)) {
      // Logs older than an hour are skipped; the skip is recorded once.
      member.skipped = true;
      cursor = { ids: [], ts: floor };
    }
    member.state.cursors[serviceId] = cursor;
    const key = `${member.state.ownerId}\u0000${info.region ?? ""}`;
    const group = groups.get(key) ?? [];
    group.push({ cursor, info, member, serviceId });
    groups.set(key, group);
  }
  for (const member of members) {
    const services = listed.get(member.state.ownerId);
    if (member.state.kind === "service") {
      const service = services?.find((item) => item.id === member.source.externalId);
      if (services && !service) {
        member.error = "Render no longer lists this service. Remove it, or check the key's access.";
        continue;
      }
      if (service) {
        member.state.serviceName = service.name;
        member.state.region = service.region;
        member.state.serviceType = service.type;
        if (service.suspended) continue;
      }
      cover(member, member.source.externalId, {
        name: member.state.serviceName ?? member.source.externalId,
        region: member.state.region ?? null,
        ...(member.state.serviceType ? { type: member.state.serviceType } : {}),
      });
      continue;
    }
    if (services) {
      member.state.services = Object.fromEntries(services.filter((service) => !service.suspended).map((service) => [
        service.id,
        { name: service.name, region: service.region, type: service.type },
      ]));
    }
    for (const [serviceId, info] of Object.entries(member.state.services)) {
      if (!own.has(serviceId)) cover(member, serviceId, info);
    }
  }
  // Cursors of services no longer read are dropped; a service that comes
  // back starts fresh.
  const covered = new Map<Member, Set<string>>();
  for (const group of groups.values()) {
    for (const item of group) covered.set(item.member, (covered.get(item.member) ?? new Set()).add(item.serviceId));
  }
  for (const member of members) {
    const ids = covered.get(member) ?? new Set<string>();
    member.state.cursors = Object.fromEntries(Object.entries(member.state.cursors).filter(([serviceId]) => ids.has(serviceId)));
  }

  const reads: Covered[][] = [];
  for (const group of groups.values()) {
    for (let start = 0; start < group.length; start += RESOURCES_PER_READ) reads.push(group.slice(start, start + RESOURCES_PER_READ));
  }
  const total = input.pageBudget ?? RENDER_PAGE_BUDGET;
  const pagesPerRead = Math.max(1, Math.floor(total / Math.max(1, reads.length)));
  let budget = total;

  for (const read of reads) {
    const start = read.map((item) => item.cursor.ts).reduce((earliest, from) => (nanos(from) < nanos(earliest) ? from : earliest));
    if (nanos(start) >= nanos(end)) continue;
    if (outcome.retryLater || budget <= 0) {
      outcome.behind = true;
      continue;
    }
    const lines: RenderLogLine[] = [];
    // Pages can share lines at their edges.
    const seen = new Set<string>();
    let startTime = start;
    let endTime = end;
    let complete = false;
    let failure: unknown = null;
    for (let page = 0; page < pagesPerRead && budget > 0; page += 1) {
      budget -= 1;
      outcome.pages += 1;
      try {
        const result = await renderLogsPage({
          apiKey: input.apiKey,
          endTime,
          limit: PAGE_SIZE,
          ownerId: read[0]!.member.state.ownerId,
          resources: read.map((item) => item.serviceId),
          startTime,
          ...fetchOption,
        });
        for (const line of result.logs) {
          const key = line.id ?? `${line.timestamp}\u0000${renderLabel(line, "resource") ?? ""}\u0000${line.message}`;
          if (seen.has(key)) continue;
          seen.add(key);
          lines.push(line);
        }
        if (!result.hasMore || !result.nextStartTime) {
          complete = true;
          break;
        }
        startTime = result.nextStartTime;
        endTime = result.nextEndTime ?? endTime;
      } catch (error) {
        failure = error;
        break;
      }
    }
    const members = [...new Set(read.map((item) => item.member))];
    const retryLater = failure instanceof RenderApiError && failure.kind === "retry_later";
    if (failure instanceof RenderApiError && failure.kind === "unauthorized") return refuse();
    if (retryLater) outcome.retryLater = true;
    else if (!complete && !failure) outcome.behind = true;
    if (failure && !retryLater) {
      for (const member of members) member.error ??= `Logs: ${errorText(failure)}`;
    }
    // Without a single line, an unfinished read moves nothing.
    if (!complete && lines.length === 0) continue;
    // A complete read covers the whole window; otherwise the pages read run
    // up to their newest line, and the next pass continues there.
    const until = complete
      ? end
      : lines.reduce((newest, line) => (nanos(line.timestamp) > nanos(newest) ? line.timestamp : newest), lines[0]!.timestamp);
    const byService = new Map(read.map((item) => [item.serviceId, item]));
    const unsent = lines.filter((line) => {
      const item = byService.get(renderLabel(line, "resource") ?? "");
      return Boolean(item) &&
        nanos(line.timestamp) <= nanos(until) &&
        !sentBefore(item!.cursor, line);
    });
    const blocks = renderLogBlocks(unsent);
    try {
      const requests = renderLogsToOtlp(blocks, {
        ownerId: read[0]!.member.state.ownerId,
        services: Object.fromEntries(read.map((item) => [item.serviceId, item.info])),
        ...(read[0]!.member.state.workspaceName ? { workspaceName: read[0]!.member.state.workspaceName } : {}),
      }, { now });
      for (const request of requests) {
        if (!(await input.forward(request))) throw new Error("Telemetry ingest did not accept the logs");
      }
    } catch (error) {
      for (const member of members) member.error ??= `Logs: ${errorText(error)}`;
      continue;
    }
    for (const block of blocks) {
      const item = byService.get(renderLabel(block.first, "resource") ?? "");
      if (item) item.member.logs += 1;
    }
    for (const item of read) {
      const serviceLines = lines.filter((line) => renderLabel(line, "resource") === item.serviceId);
      item.member.state.cursors[item.serviceId] = advanceCursor(item.cursor, until, serviceLines);
    }
  }

  for (const member of members) {
    results.set(member.source.id, {
      error: member.error,
      logs: member.logs,
      received: member.logs > 0,
      state: member.state as unknown as Record<string, unknown>,
      truncated: member.skipped,
    });
  }
  return outcome;
}

