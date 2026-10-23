// Shared read-only OpenTelemetry query adapter used by multiple application
// surfaces. Every query is scoped to one workspace: the ingest endpoint stores
// its organization ID in the superlog.project_id resource attribute, which the
// tables also keep as SuperlogProjectId or project_id.
import type { ClickHouseClient } from "@clickhouse/client";
import {
  AI_MODEL_EXPR,
  AI_PROVIDER_EXPR,
  AI_TIER_EXPR,
  AI_USAGE_CONDITION,
  aiFieldExpr,
  aiGroupExpr,
  emptyAiPriceParams,
  isAiMeasureField,
  type AiModelKey,
  type AiPriceParams,
} from "./ai-cost.js";

export type TimeRange = { since?: string; until?: string };
export type ResourceAttrFilter = {
  key: string;
  value: string;
  op?: "eq" | "neq" | "not_contains";
  // Several values: eq matches any of them, neq and not_contains none of them.
  values?: string[];
};

type AttributeColumn = "Attributes" | "ResourceAttributes" | "SpanAttributes" | "LogAttributes";
// `field` is not an attribute map — it routes a `field.<name>` filter key to a
// top-level column (TraceId, SpanId, SeverityNumber) via the fieldColumnExpr
// allowlist below, so the explore UI can filter on identifiers, not just attrs.
type AttributeScope = "resource" | "span" | "log" | "field";
type ParsedAttributeKey = { scope: AttributeScope; key: string };

export type FieldFilterSource = "logs" | "traces";

export async function retryOneConnectionReset<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof Error) || (error as Error & { code?: string }).code !== "ECONNRESET") {
      throw error;
    }
    return read();
  }
}

// Allowlist mapping a `field.<name>` filter key to the ClickHouse column
// expression it compares against (as a String). Returns null for anything not
// on the list so an arbitrary `field.*` key can never reach the query — the
// value is always bound as a parameter, the column expression never is.
export function fieldColumnExpr(field: string, source: FieldFilterSource): string | null {
  switch (field) {
    case "trace_id":
      return "TraceId";
    case "span_id":
      return "SpanId";
    case "severity_number":
      // SeverityNumber only exists on logs; cast so the String param compares.
      return source === "logs" ? "toString(SeverityNumber)" : null;
    default:
      return null;
  }
}

const RELATIVE_TIME_EXPR_RE =
  /^now\(\)(?:\s*-\s*INTERVAL\s+(?:[1-9][0-9]*)\s+(?:SECOND|MINUTE|HOUR|DAY|WEEK|MONTH))?$/i;
const ISO_TIME_BOUND_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

function timeBoundExpr(value: string, paramName: "since" | "until"): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (RELATIVE_TIME_EXPR_RE.test(normalized)) return normalized;
  if (!ISO_TIME_BOUND_RE.test(normalized) || Number.isNaN(Date.parse(normalized))) {
    throw new Error(`invalid ${paramName} time bound: ${value}`);
  }
  return `parseDateTime64BestEffortOrZero({${paramName}:String})`;
}

export function resolveRange(range?: TimeRange): {
  sinceSql: string;
  untilSql: string;
  sinceExpr: string;
  untilExpr: string;
} {
  const since = range?.since ?? "now() - INTERVAL 1 HOUR";
  const until = range?.until ?? "now()";
  return {
    sinceSql: since,
    untilSql: until,
    sinceExpr: timeBoundExpr(since, "since"),
    untilExpr: timeBoundExpr(until, "until"),
  };
}

function attrConds(
  attrs: ResourceAttrFilter[] | undefined,
  column: AttributeColumn = "ResourceAttributes",
  paramPrefix = "attr",
): {
  conds: string[];
  params: Record<string, string | string[]>;
} {
  const conds: string[] = [];
  const params: Record<string, string | string[]> = {};
  if (!attrs) return { conds, params };
  attrs.forEach((a, i) => {
    const kName = `${paramPrefix}_k_${i}`;
    const vName = `${paramPrefix}_v_${i}`;
    // service.name lives in the dedicated ServiceName column, which leads
    // every otel table's primary key — filter it natively so ClickHouse can
    // prune to the service's PK range instead of scanning the resource map
    // for the whole window. (The collector populates ServiceName from the
    // service.name resource attribute, so the two are equivalent.)
    const native = column === "ResourceAttributes" && a.key === "service.name";
    const target = native ? "ServiceName" : `${column}[{${kName}:String}]`;
    if (a.values) {
      if (a.op === "not_contains") {
        conds.push(`arrayAll(v -> positionCaseInsensitive(${target}, v) = 0, {${vName}:Array(String)})`);
      } else {
        conds.push(`${target} ${a.op === "neq" ? "NOT IN" : "IN"} {${vName}:Array(String)}`);
      }
      if (!native) params[kName] = a.key;
      params[vName] = a.values;
      return;
    }
    if (a.op === "neq") {
      conds.push(`${target} != {${vName}:String}`);
    } else if (a.op === "not_contains") {
      conds.push(`positionCaseInsensitive(${target}, {${vName}:String}) = 0`);
    } else {
      conds.push(`${target} = {${vName}:String}`);
    }
    if (!native) params[kName] = a.key;
    params[vName] = a.value;
  });
  return { conds, params };
}

function parseAttributeKey(key: string): ParsedAttributeKey {
  if (key.startsWith("resource.")) return { scope: "resource", key: key.slice("resource.".length) };
  if (key.startsWith("span.")) return { scope: "span", key: key.slice("span.".length) };
  if (key.startsWith("log.")) return { scope: "log", key: key.slice("log.".length) };
  if (key.startsWith("field.")) return { scope: "field", key: key.slice("field.".length) };
  return { scope: "resource", key };
}

function splitAttrs(
  attrs: ResourceAttrFilter[] | undefined,
): Record<AttributeScope, ResourceAttrFilter[]> {
  const out: Record<AttributeScope, ResourceAttrFilter[]> = {
    resource: [],
    span: [],
    log: [],
    field: [],
  };
  for (const attr of attrs ?? []) {
    const parsed = parseAttributeKey(attr.key);
    out[parsed.scope].push({ ...attr, key: parsed.key });
  }
  return out;
}

// Build conditions for `field.*` filters against top-level columns. Only keys
// on the fieldColumnExpr allowlist for this source produce a condition;
// everything else is silently dropped.
function fieldConds(
  attrs: ResourceAttrFilter[],
  source: FieldFilterSource,
  paramPrefix = "fattr",
): { conds: string[]; params: Record<string, string | string[]> } {
  const conds: string[] = [];
  const params: Record<string, string | string[]> = {};
  attrs.forEach((a, i) => {
    const expr = fieldColumnExpr(a.key, source);
    if (!expr) return;
    const vName = `${paramPrefix}_v_${i}`;
    if (a.values) {
      if (a.op === "not_contains") {
        conds.push(`arrayAll(v -> positionCaseInsensitive(${expr}, v) = 0, {${vName}:Array(String)})`);
      } else {
        conds.push(`${expr} ${a.op === "neq" ? "NOT IN" : "IN"} {${vName}:Array(String)}`);
      }
      params[vName] = a.values;
      return;
    }
    if (a.op === "not_contains") conds.push(`positionCaseInsensitive(${expr}, {${vName}:String}) = 0`);
    else conds.push(`${expr} ${a.op === "neq" ? "!=" : "="} {${vName}:String}`);
    params[vName] = a.value;
  });
  return { conds, params };
}

// Conditions that each listed column holds one of its values. Empty lists
// add nothing.
function anyOfConds(
  lists: Array<{ expr: string; param: string; values: string[] | undefined }>,
): { conds: string[]; params: Record<string, string[]> } {
  const conds: string[] = [];
  const params: Record<string, string[]> = {};
  for (const list of lists) {
    if (!list.values?.length) continue;
    conds.push(`${list.expr} IN {${list.param}:Array(String)}`);
    params[list.param] = list.values;
  }
  return { conds, params };
}

function groupExprForAttribute(
  groupBy: string | undefined,
  source: SeriesSource,
  paramName = "groupKey",
): { expr: string; params: Record<string, string> } {
  if (groupBy === "service.name" || groupBy === "service") {
    return { expr: "ServiceName", params: {} };
  }
  // Log level or span status, as the explorers' count charts and facets show them.
  if (groupBy === "severity" && source === "logs") {
    return { expr: "upper(SeverityText)", params: {} };
  }
  if (groupBy === "status" && source === "traces") {
    return { expr: "StatusCode", params: {} };
  }
  if (groupBy === "operation" && source === "traces") {
    return { expr: "SpanName", params: {} };
  }
  const aiGroup = source === "traces" && groupBy ? aiGroupExpr(groupBy) : null;
  if (aiGroup) return { expr: aiGroup, params: {} };
  if (groupBy?.startsWith("attr:")) {
    return {
      expr:
        source === "logs"
          ? `LogAttributes[{${paramName}:String}]`
          : `SpanAttributes[{${paramName}:String}]`,
      params: { [paramName]: groupBy.slice("attr:".length) },
    };
  }
  if (groupBy) {
    const parsed = parseAttributeKey(groupBy);
    if (parsed.scope === "resource") {
      return { expr: `ResourceAttributes[{${paramName}:String}]`, params: { [paramName]: parsed.key } };
    }
    if (parsed.scope === "log" && source === "logs") {
      return { expr: `LogAttributes[{${paramName}:String}]`, params: { [paramName]: parsed.key } };
    }
    if (parsed.scope === "span" && source === "traces") {
      return { expr: `SpanAttributes[{${paramName}:String}]`, params: { [paramName]: parsed.key } };
    }
  }
  return { expr: "''", params: {} };
}

export async function queryLogs(
  ch: ClickHouseClient,
  organizationId: string,
  params: {
    range?: TimeRange;
    service?: string;
    severity?: string;
    search?: string;
    traceId?: string;
    resourceAttrs?: ResourceAttrFilter[];
    logAttrs?: ResourceAttrFilter[];
    // Any of these services or levels.
    services?: string[];
    severities?: string[];
    limit: number;
  },
) {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(params.range);
  const split = splitAttrs(params.resourceAttrs);
  const attr = attrConds(split.resource);
  const logAttr = attrConds([...split.log, ...(params.logAttrs ?? [])], "LogAttributes", "lattr");
  const field = fieldConds(split.field, "logs");
  const anyOf = anyOfConds([
    { expr: "ServiceName", param: "services", values: params.services },
    { expr: "upper(SeverityText)", param: "severities", values: params.severities?.map((value) => value.toUpperCase()) },
  ]);
  const conds: string[] = [
    "SuperlogProjectId = {organizationId:String}",
    `Timestamp >= ${sinceExpr}`,
    `Timestamp <= ${untilExpr}`,
    // otel_logs is partitioned by toDate(TimestampTime) and sorted by
    // (ServiceName, TimestampTime, Timestamp). Filtering only Timestamp — a
    // different column — gives ClickHouse nothing to prune partitions by, so it
    // scans every retained day (incident 2026-06-25: ~12M rows for a 1h window).
    // Bracketing TimestampTime by the same window lets the partition minmax
    // index prune to the queried days. TimestampTime = toDateTime(Timestamp) is
    // truncated down to the second, so pad the lower bound by 1s to never drop a
    // sub-second row the precise Timestamp filter above keeps.
    `TimestampTime >= (${sinceExpr}) - INTERVAL 1 SECOND`,
    `TimestampTime <= ${untilExpr}`,
    ...attr.conds,
    ...logAttr.conds,
    ...field.conds,
    ...anyOf.conds,
  ];
  if (params.service) conds.push("ServiceName = {service:String}");
  if (params.severity) conds.push("upper(SeverityText) = upper({severity:String})");
  if (params.search) conds.push("positionCaseInsensitive(Body, {search:String}) > 0");
  if (params.traceId) conds.push("TraceId = {traceId:String}");

  const query = `
    SELECT
      toString(Timestamp) AS timestamp,
      ServiceName AS service,
      SeverityText AS severity,
      toUInt8(SeverityNumber) AS severity_number,
      Body AS body,
      TraceId AS trace_id,
      SpanId AS span_id,
      LogAttributes AS log_attrs,
      ResourceAttributes AS resource_attrs,
      LogAttributes['exception.type'] AS exception_type,
      LogAttributes['exception.message'] AS exception_message,
      LogAttributes['exception.stacktrace'] AS exception_stacktrace
    FROM otel_logs
    WHERE ${conds.join(" AND ")}
    ORDER BY Timestamp DESC
    LIMIT {limit:UInt32}
  `;
  return retryOneConnectionReset(async () => {
    const r = await ch.query({
      query,
      query_params: {
        organizationId,
        since: sinceSql,
        until: untilSql,
        service: params.service ?? "",
        severity: params.severity ?? "",
        search: params.search ?? "",
        traceId: params.traceId ?? "",
        limit: params.limit,
        ...attr.params,
        ...logAttr.params,
        ...field.params,
        ...anyOf.params,
      },
      format: "JSONEachRow",
    });
    return r.json();
  });
}

export async function queryTraces(
  ch: ClickHouseClient,
  organizationId: string,
  params: {
    range?: TimeRange;
    service?: string;
    spanName?: string;
    statusCode?: string;
    minDurationMs?: number;
    resourceAttrs?: ResourceAttrFilter[];
    spanAttrs?: ResourceAttrFilter[];
    limit: number;
  },
) {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(params.range);
  const split = splitAttrs(params.resourceAttrs);
  const attr = attrConds(split.resource);
  const spanAttr = attrConds(
    [...split.span, ...(params.spanAttrs ?? [])],
    "SpanAttributes",
    "sattr",
  );
  const field = fieldConds(split.field, "traces");
  const conds: string[] = [
    "SuperlogProjectId = {organizationId:String}",
    `Timestamp >= ${sinceExpr}`,
    `Timestamp <= ${untilExpr}`,
    ...attr.conds,
    ...spanAttr.conds,
    ...field.conds,
  ];
  if (params.service) conds.push("ServiceName = {service:String}");
  if (params.spanName) conds.push("SpanName = {spanName:String}");
  if (params.statusCode) conds.push("StatusCode = {statusCode:String}");
  if (typeof params.minDurationMs === "number") {
    conds.push("Duration >= {minDurationNs:UInt64}");
  }

  const query = `
    SELECT
      toString(Timestamp) AS timestamp,
      TraceId AS trace_id,
      SpanId AS span_id,
      ParentSpanId AS parent_span_id,
      ServiceName AS service,
      SpanName AS span_name,
      SpanKind AS span_kind,
      StatusCode AS status_code,
      StatusMessage AS status_message,
      Duration / 1000000 AS duration_ms,
      SpanAttributes AS span_attrs,
      ResourceAttributes AS resource_attrs,
      indexOf(Events.Name, 'exception') AS exception_event_index,
      if(exception_event_index = 0, '', Events.Attributes[exception_event_index]['exception.type']) AS exception_type,
      if(exception_event_index = 0, '', Events.Attributes[exception_event_index]['exception.message']) AS exception_message,
      if(exception_event_index = 0, '', Events.Attributes[exception_event_index]['exception.stacktrace']) AS exception_stacktrace
    FROM otel_traces
    WHERE ${conds.join(" AND ")}
    ORDER BY Timestamp DESC
    LIMIT {limit:UInt32}
  `;
  return retryOneConnectionReset(async () => {
    const r = await ch.query({
      query,
      query_params: {
        organizationId,
        since: sinceSql,
        until: untilSql,
        service: params.service ?? "",
        spanName: params.spanName ?? "",
        statusCode: params.statusCode ?? "",
        minDurationNs: Math.round((params.minDurationMs ?? 0) * 1_000_000),
        limit: params.limit,
        ...attr.params,
        ...spanAttr.params,
        ...field.params,
      },
      format: "JSONEachRow",
    });
    return r.json();
  });
}

type TracesAggregatedParams = {
  range?: TimeRange;
  service?: string;
  spanName?: string;
  statusCode?: string;
  // A trace qualifies when one of its spans has any of these values.
  services?: string[];
  spanNames?: string[];
  statusCodes?: string[];
  minDurationMs?: number;
  resourceAttrs?: ResourceAttrFilter[];
  limit: number;
};

// How many of the newest spans the recent-index step reverse-scans to find the
// most recently started traces. Far more than any page needs (a high-volume
// project fits thousands of traces in these spans; a small one has fewer total),
// so the true newest traces are always covered, while the bound keeps the scan a
// few granules regardless of how big the window nominally is.
const TRACE_RECENT_SCAN_CAP = 50_000;

// Step 1 (the recent index) is only a candidate generator; step 2 (the summary)
// is authoritative for which traces started in the window and for the ordering.
// Over-fetch candidates by this factor so that traces which step 1 surfaces by
// recent activity but step 2 drops (their start is before the window) don't
// shrink the page below the requested limit.
const TRACE_CANDIDATE_OVERFETCH = 5;

// The trace-summary fast path holds one aggregate-state row per trace with no
// per-span dimensions, and picks "recent" from a span-only time index — so it
// can only answer the unfiltered trace list (the default view, and the one that
// times out on the raw scan for high-volume projects). Any span-selecting filter
// — service, span name, status code, an attribute predicate — or a duration
// floor (which could exclude more traces than the recent window holds) needs the
// raw table.
function traceSummaryEligible(params: TracesAggregatedParams): boolean {
  if (params.service) return false;
  if (params.spanName) return false;
  if (params.statusCode) return false;
  if (params.services?.length || params.spanNames?.length || params.statusCodes?.length) return false;
  if (params.minDurationMs) return false;
  if (params.resourceAttrs?.length) return false;
  return true;
}

// The materialized views only populate the derived tables from their creation
// forward; the one-shot backfill fills earlier history. Until history reaches
// back past the window start, the fast path would return a truncated list (only
// post-migration traces) where the raw scan showed the full window. Gate on the
// recent index actually holding a row older than the window start for this
// project: if it doesn't, the window isn't fully covered — fall back to the raw
// scan. This makes activation self-correcting (per project, per window) rather
// than flipping on the moment the tables exist. A brand-new project with no
// history before the window also falls back, which is fine — it is low-volume and
// the raw scan is fast there.
async function traceRollupCoversWindow(
  ch: ClickHouseClient,
  organizationId: string,
  sinceExpr: string,
  sinceSql: string,
): Promise<boolean> {
  const rows = await retryOneConnectionReset(async () => {
    const r = await ch.query({
      query: `
      SELECT count() AS c
      FROM (
        SELECT 1
        FROM otel_traces_recent
        WHERE project_id = {organizationId:String} AND ts < ${sinceExpr}
        LIMIT 1
      )
    `,
      query_params: { organizationId, since: sinceSql },
      format: "JSONEachRow",
    });
    return (await r.json()) as { c: string | number }[];
  });
  return Number(rows[0]?.c ?? 0) > 0;
}

// Two-step read: (1) otel_traces_recent, a plain time-ordered span index, gives
// recent candidate trace_ids via a bounded reverse scan + GROUP BY; (2)
// otel_traces_summary filters those to traces whose start is in the window,
// supplies the displayed stats, and orders the page. Neither step scans the
// whole per-project window, so it stays ~1s where the raw GROUP BY over raw
// otel_traces is 15-60s. Output columns match the raw queryTracesAggregated query
// exactly so callers are unaffected.
//
// Semantics: the list is "traces whose start falls in [since, until]", with
// whole-trace stats (all of a trace's spans), ordered by start. For the default
// list (until = now) every included trace started at or after `since`, so all its
// spans lie in the window and the stats equal the raw window-clipped values; they
// can differ from the raw scan only for a historical window (until in the past)
// that a long trace straddles — negligible for the short traces this serves.
async function queryTracesAggregatedFromSummary(
  ch: ClickHouseClient,
  organizationId: string,
  params: TracesAggregatedParams,
) {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(params.range);
  const candidateLimit = params.limit * TRACE_CANDIDATE_OVERFETCH;
  const query = `
    WITH recent_ids AS (
      SELECT trace_id
      FROM (
        SELECT ts, trace_id
        FROM otel_traces_recent
        WHERE project_id = {organizationId:String}
          AND ts >= ${sinceExpr}
          AND ts <= ${untilExpr}
        ORDER BY ts DESC
        LIMIT ${TRACE_RECENT_SCAN_CAP}
      )
      GROUP BY trace_id
      ORDER BY min(ts) DESC
      LIMIT ${candidateLimit}
    )
    SELECT
      trace_id,
      toString(min(start)) AS start_time,
      argMinMerge(root_span_name) AS root_span_name,
      argMinMerge(root_service) AS root_service,
      argMinMerge(root_status_code) AS root_status_code,
      sum(span_count) AS span_count,
      sum(error_count) AS error_count,
      uniqExactMerge(services) AS service_count,
      toFloat64(max(end_unix_nano) - min(start_unix_nano)) / 1000000 AS duration_ms
    FROM otel_traces_summary
    WHERE project_id = {organizationId:String}
      AND trace_id IN (recent_ids)
      AND start >= ${sinceExpr}
      AND start <= ${untilExpr}
    GROUP BY project_id, trace_id
    ORDER BY start_time DESC
    LIMIT {limit:UInt32}
  `;
  return retryOneConnectionReset(async () => {
    const r = await ch.query({
      query,
      query_params: { organizationId, since: sinceSql, until: untilSql, limit: params.limit },
      format: "JSONEachRow",
    });
    return r.json();
  });
}

export async function queryTracesAggregated(
  ch: ClickHouseClient,
  organizationId: string,
  params: TracesAggregatedParams,
) {
  // Fast path only when it is both available and complete for this window: both
  // derived tables exist (either missing — local dev, or before the migration
  // lands — falls back), and the recent index reaches back past the window start
  // (otherwise the list would be silently truncated to post-migration data).
  if (
    traceSummaryEligible(params) &&
    (await tableExists(ch, "otel_traces_recent")) &&
    (await tableExists(ch, "otel_traces_summary"))
  ) {
    const { sinceExpr, sinceSql } = resolveRange(params.range);
    if (await traceRollupCoversWindow(ch, organizationId, sinceExpr, sinceSql)) {
      return queryTracesAggregatedFromSummary(ch, organizationId, params);
    }
  }
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(params.range);
  const split = splitAttrs(params.resourceAttrs);
  const attr = attrConds(split.resource);
  const spanAttr = attrConds(split.span, "SpanAttributes", "sattr");
  const field = fieldConds(split.field, "traces");
  // Outer scope: trace-level. We aggregate over every span of every matching
  // trace in the window so span_count / duration_ms / error_count describe the
  // whole trace rather than only the spans matching span-level filters.
  const outerConds: string[] = [
    "SuperlogProjectId = {organizationId:String}",
    `Timestamp >= ${sinceExpr}`,
    `Timestamp <= ${untilExpr}`,
    ...attr.conds,
  ];
  // Inner scope: span-level filters pick which TraceIds qualify. Identifier
  // (field.*) filters like span_id are span-level too.
  const anyOf = anyOfConds([
    { expr: "ServiceName", param: "services", values: params.services },
    { expr: "SpanName", param: "spanNames", values: params.spanNames },
    { expr: "StatusCode", param: "statusCodes", values: params.statusCodes },
  ]);
  const innerConds: string[] = [...outerConds, ...spanAttr.conds, ...field.conds, ...anyOf.conds];
  if (params.service) innerConds.push("ServiceName = {service:String}");
  if (params.spanName) innerConds.push("SpanName = {spanName:String}");
  if (params.statusCode) innerConds.push("StatusCode = {statusCode:String}");
  const hasSpanLevelFilter = !!(
    params.service ||
    params.spanName ||
    params.statusCode ||
    spanAttr.conds.length ||
    field.conds.length ||
    anyOf.conds.length
  );

  // After GROUP BY TraceId, filter by total duration if requested.
  const havingMinDuration =
    typeof params.minDurationMs === "number" && params.minDurationMs > 0
      ? `HAVING duration_ms >= ${Math.round(params.minDurationMs * 1000) / 1000}`
      : "";

  const traceIdSubquery = hasSpanLevelFilter
    ? `AND TraceId IN (
        SELECT DISTINCT TraceId FROM otel_traces
        WHERE ${innerConds.join(" AND ")}
      )`
    : "";

  const query = `
    SELECT
      TraceId AS trace_id,
      toString(min(Timestamp)) AS start_time,
      argMin(SpanName, Timestamp) AS root_span_name,
      argMin(ServiceName, Timestamp) AS root_service,
      argMin(StatusCode, Timestamp) AS root_status_code,
      count() AS span_count,
      countIf(StatusCode = 'STATUS_CODE_ERROR') AS error_count,
      uniqExact(ServiceName) AS service_count,
      toFloat64(
        max(toUnixTimestamp64Nano(Timestamp) + Duration) -
        min(toUnixTimestamp64Nano(Timestamp))
      ) / 1000000 AS duration_ms
    FROM otel_traces
    WHERE ${outerConds.join(" AND ")}
      ${traceIdSubquery}
    GROUP BY TraceId
    ${havingMinDuration}
    ORDER BY min(Timestamp) DESC
    LIMIT {limit:UInt32}
  `;
  return retryOneConnectionReset(async () => {
    const r = await ch.query({
      query,
      query_params: {
        organizationId,
        since: sinceSql,
        until: untilSql,
        service: params.service ?? "",
        spanName: params.spanName ?? "",
        statusCode: params.statusCode ?? "",
        limit: params.limit,
        ...attr.params,
        ...spanAttr.params,
        ...field.params,
        ...anyOf.params,
      },
      format: "JSONEachRow",
    });
    return r.json();
  });
}

export async function getTraceDetail(ch: ClickHouseClient, organizationId: string, traceId: string) {
  // otel_traces / otel_logs are partitioned by day and sorted by
  // (ServiceName, SpanName, Timestamp), so a bare `TraceId = …` predicate can't
  // use the primary index — it scans every partition (all retained days, every
  // part). That's a multi-second-to-minutes full scan on a busy table, and a
  // burst of trace-detail loads saturates the read pool and starves every other
  // query (incident 2026-06-25: this was the lever that took prod reads down).
  // otel_traces_trace_id_ts is sorted by TraceId, so it resolves the trace's
  // [Start, End] window in O(log n); bounding Timestamp by it prunes the scan to
  // the 1–2 daily partitions the trace actually lives in.
  //
  // Fallback when the index has no row for this trace: scan the FULL retained
  // range (epoch → now), i.e. the old slow-but-correct full scan. A missing row
  // is not necessarily a just-ingested trace — it can be an older trace whose
  // index entry was never written (MV gap, or a span pre-dating the view) — so a
  // "recent" fallback window would silently return an empty trace for real data.
  // Correctness wins here; the table TTL already caps how far back the scan can
  // go, and the common case (row present — the MV writes it on insert) stays
  // tightly bounded and fast.
  const winStart = `coalesce(
              (SELECT min(Start) FROM otel_traces_trace_id_ts WHERE TraceId = {traceId:String}),
              toDateTime(0)
            ) - INTERVAL 1 MINUTE`;
  const winEnd = `coalesce(
              (SELECT max(End) FROM otel_traces_trace_id_ts WHERE TraceId = {traceId:String}),
              now()
            ) + INTERVAL 1 MINUTE`;
  // otel_traces is partitioned by toDate(Timestamp), so a Timestamp window prunes it.
  const traceWindow = `
        AND Timestamp >= ${winStart}
        AND Timestamp <= ${winEnd}`;
  // otel_logs is partitioned by toDate(TimestampTime), so it needs the window on
  // TimestampTime too (the 1-minute margins above already cover the sub-second
  // truncation, so no extra padding is needed here). Without this the logs leg
  // of the trace view scans every retained day.
  const logWindow = `${traceWindow}
        AND TimestampTime >= ${winStart}
        AND TimestampTime <= ${winEnd}`;

  const readSpans = () =>
    retryOneConnectionReset(async () => {
      const result = await ch.query({
        query: `
      SELECT
        toString(Timestamp) AS timestamp,
        toString(toUnixTimestamp64Nano(Timestamp)) AS start_ns,
        TraceId AS trace_id,
        SpanId AS span_id,
        ParentSpanId AS parent_span_id,
        ServiceName AS service,
        SpanName AS span_name,
        SpanKind AS span_kind,
        StatusCode AS status_code,
        StatusMessage AS status_message,
        toString(Duration) AS duration_ns,
        toFloat64(Duration) / 1000000 AS duration_ms,
        SpanAttributes AS span_attrs,
        ResourceAttributes AS resource_attrs,
        indexOf(Events.Name, 'exception') AS exception_event_index,
        if(exception_event_index = 0, '', Events.Attributes[exception_event_index]['exception.type']) AS exception_type,
        if(exception_event_index = 0, '', Events.Attributes[exception_event_index]['exception.message']) AS exception_message,
        if(exception_event_index = 0, '', Events.Attributes[exception_event_index]['exception.stacktrace']) AS exception_stacktrace
      FROM otel_traces
      WHERE SuperlogProjectId = {organizationId:String}
        AND TraceId = {traceId:String}${traceWindow}
      ORDER BY Timestamp ASC, SpanId ASC
      LIMIT 5000
    `,
        query_params: { organizationId, traceId },
        format: "JSONEachRow",
      });
      return result.json();
    });

  const readLogs = () =>
    retryOneConnectionReset(async () => {
      const result = await ch.query({
        query: `
      SELECT
        toString(Timestamp) AS timestamp,
        toString(toUnixTimestamp64Nano(Timestamp)) AS ts_ns,
        ServiceName AS service,
        SeverityText AS severity,
        Body AS body,
        TraceId AS trace_id,
        SpanId AS span_id,
        LogAttributes AS log_attrs,
        ResourceAttributes AS resource_attrs,
        LogAttributes['exception.type'] AS exception_type,
        LogAttributes['exception.message'] AS exception_message,
        LogAttributes['exception.stacktrace'] AS exception_stacktrace
      FROM otel_logs
      WHERE SuperlogProjectId = {organizationId:String}
        AND TraceId = {traceId:String}${logWindow}
      ORDER BY Timestamp ASC
      LIMIT 5000
    `,
        query_params: { organizationId, traceId },
        format: "JSONEachRow",
      });
      return result.json();
    });

  const [spans, logs] = await Promise.all([readSpans(), readLogs()]);
  return { spans, logs };
}

export async function queryMetrics(
  ch: ClickHouseClient,
  organizationId: string,
  params: {
    metricName?: string;
    service?: string;
    range?: TimeRange;
    resourceAttrs?: ResourceAttrFilter[];
    limit: number;
  },
) {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(params.range);
  const attr = attrConds(metricResourceAttrs(params.resourceAttrs));

  const perTable = await Promise.all(
    METRIC_TABLES.map(async ({ table, kind }): Promise<Record<string, unknown>[]> => {
      const conds: string[] = [
        "ResourceAttributes['superlog.project_id'] = {organizationId:String}",
        `TimeUnix >= ${sinceExpr}`,
        `TimeUnix <= ${untilExpr}`,
        ...attr.conds,
      ];
      if (params.metricName) conds.push("MetricName = {metricName:String}");
      if (params.service) conds.push("ResourceAttributes['service.name'] = {service:String}");

      // Histograms/summaries have no scalar Value; surface the rolled-up
      // Count/Sum (and Min/Max for histograms) so a point conveys more than just
      // "an observation happened". Min/Max don't exist on the summary table.
      const valueExpr =
        kind === "histogram" || kind === "exponential_histogram"
          ? "NULL AS value, Count AS count, Sum AS sum, Min AS min, Max AS max"
          : kind === "summary"
            ? "NULL AS value, Count AS count, Sum AS sum, NULL AS min, NULL AS max"
            : "Value AS value, NULL AS count, NULL AS sum, NULL AS min, NULL AS max";

      const query = `
      SELECT
        '${kind}' AS kind,
        toString(TimeUnix) AS timestamp,
        toString(StartTimeUnix) AS start_time,
        MetricName AS metric_name,
        MetricUnit AS unit,
        ResourceAttributes['service.name'] AS service,
        ${valueExpr},
        ${kind === "sum" || kind === "histogram" || kind === "exponential_histogram" ? "AggregationTemporality" : "NULL"} AS aggregation_temporality,
        ${kind === "sum" ? "IsMonotonic" : "NULL"} AS is_monotonic,
        Attributes AS attributes,
        ResourceAttributes AS resource_attrs
      FROM ${table}
      WHERE ${conds.join(" AND ")}
      ORDER BY TimeUnix DESC
      LIMIT {limit:UInt32}
    `;

      try {
        return await retryOneConnectionReset(async () => {
          const r = await ch.query({
            query,
            query_params: {
              organizationId,
              since: sinceSql,
              until: untilSql,
              metricName: params.metricName ?? "",
              service: params.service ?? "",
              limit: params.limit,
              ...attr.params,
            },
            format: "JSONEachRow",
          });
          return (await r.json()) as Record<string, unknown>[];
        });
      } catch (err) {
        // metric tables may not exist if no metrics of this kind have been ingested yet
        if (!isMissingMetricTableError(err)) throw err;
        return [];
      }
    }),
  );

  const results = perTable.flat();
  results.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return results.slice(0, params.limit);
}

const SERVICE_SOURCES = [
  { table: "otel_traces", service: "ServiceName", time: "Timestamp" },
  { table: "otel_logs", service: "ServiceName", time: "Timestamp" },
  {
    table: "otel_metrics_gauge",
    service: "ServiceName",
    time: "TimeUnix",
  },
  {
    table: "otel_metrics_sum",
    service: "ServiceName",
    time: "TimeUnix",
  },
  {
    table: "otel_metrics_histogram",
    service: "ServiceName",
    time: "TimeUnix",
  },
  {
    table: "otel_metrics_exp_histogram",
    service: "ServiceName",
    time: "TimeUnix",
  },
  {
    table: "otel_metrics_summary",
    service: "ServiceName",
    time: "TimeUnix",
  },
] as const;

// Services seen in any signal, or only in logs or traces.
export async function listServices(
  ch: ClickHouseClient,
  organizationId: string,
  range?: TimeRange,
  signal?: "logs" | "traces",
) {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(range);
  const sources = signal
    ? SERVICE_SOURCES.filter((source) => source.table === `otel_${signal}`)
    : SERVICE_SOURCES;
  const servicesBySource = await Promise.all(
    sources.map(async (source): Promise<string[]> => {
      // Logs are partitioned by TimestampTime. Keep the canonical nanosecond
      // Timestamp filter for exactness, and add the padded partition-key window
      // so ClickHouse can prune retained log partitions efficiently.
      const logPartitionWindow =
        source.table === "otel_logs"
          ? `
          AND TimestampTime >= (${sinceExpr}) - INTERVAL 1 SECOND
          AND TimestampTime <= ${untilExpr}`
          : "";
      const projectFilter = source.table.startsWith("otel_metrics_")
        ? "ResourceAttributes['superlog.project_id'] = {organizationId:String}"
        : "SuperlogProjectId = {organizationId:String}";
      const query = `
        SELECT DISTINCT ${source.service} AS service
        FROM ${source.table}
        WHERE ${projectFilter}
          AND ${source.time} >= ${sinceExpr}
          AND ${source.time} <= ${untilExpr}${logPartitionWindow}
          AND ${source.service} != ''
        ORDER BY service
        LIMIT 200
      `;
      try {
        const r = await ch.query({
          query,
          query_params: { organizationId, since: sinceSql, until: untilSql },
          format: "JSONEachRow",
        });
        const rows = (await r.json()) as { service: string }[];
        return rows.map((row) => row.service);
      } catch (err) {
        if (!isMissingMetricTableError(err)) throw err;
        return [];
      }
    }),
  );
  return [...new Set(servicesBySource.flat())].sort().slice(0, 200);
}

// Discovering which attribute keys exist only needs a representative sample of
// rows, not every row in the window. High-volume projects produce millions of
// spans/logs per hour, and reading the full ResourceAttributes/SpanAttributes
// map columns across all of them took 15-30s — past the 10s ClickHouse
// request_timeout — so the explore filter dropdown 500'd. Capping the rows each
// scan reads before the arrayJoin/group keeps the query ~1s while still
// surfacing effectively every key: ClickHouse reads parts in parallel, so the
// cap samples across the window rather than just the head. Counts become
// approximate, which is fine for ordering the dropdown. Low-volume projects read
// fewer rows than the cap and stay exact.
const ATTRIBUTE_KEY_SCAN_ROW_CAP = 1_000_000;

export async function listAttributeKeys(
  ch: ClickHouseClient,
  organizationId: string,
  range?: TimeRange,
  source?: SeriesSource | "metrics",
): Promise<{ key: string; count: number }[]> {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(range);
  const resourceFromLogs = source === undefined || source === "logs" || source === "metrics";
  const resourceFromTraces = source === undefined || source === "traces" || source === "metrics";
  // Reads at most ATTRIBUTE_KEY_SCAN_ROW_CAP rows from `table`, then expands the
  // chosen map column's keys. `prefix` namespaces keys by scope (resource./span./log.);
  // pass "" to emit the bare key (the unscoped `source === undefined` case).
  const keyScan = (table: string, column: string, prefix: string): string => {
    const keyExpr = prefix ? `concat('${prefix}', k)` : "k";
    return `
      SELECT ${keyExpr} AS k, count() AS c FROM (
        SELECT mapKeys(${column}) AS mk
        FROM ${table}
        WHERE SuperlogProjectId = {organizationId:String}
          AND Timestamp >= ${sinceExpr}
          AND Timestamp <= ${untilExpr}
        LIMIT ${ATTRIBUTE_KEY_SCAN_ROW_CAP}
      ) ARRAY JOIN mk AS k
      GROUP BY k`;
  };
  const subqueries: string[] = [];
  if (source === undefined) {
    subqueries.push(keyScan("otel_logs", "ResourceAttributes", ""));
    subqueries.push(keyScan("otel_traces", "ResourceAttributes", ""));
  } else {
    if (resourceFromLogs) {
      subqueries.push(keyScan("otel_logs", "ResourceAttributes", "resource."));
    }
    if (source === "logs") {
      subqueries.push(keyScan("otel_logs", "LogAttributes", "log."));
    }
    if (resourceFromTraces) {
      subqueries.push(keyScan("otel_traces", "ResourceAttributes", "resource."));
    }
    if (source === "traces") {
      subqueries.push(keyScan("otel_traces", "SpanAttributes", "span."));
    }
  }
  const query = `
    SELECT k, sum(c) AS c FROM (
      ${subqueries.join("\n      UNION ALL\n")}
    )
    WHERE k != 'superlog.project_id' AND k != 'resource.superlog.project_id' AND k != ''
    GROUP BY k
    ORDER BY c DESC
    LIMIT 200
  `;
  const r = await ch.query({
    query,
    query_params: { organizationId, since: sinceSql, until: untilSql },
    format: "JSONEachRow",
  });
  const rows = (await r.json()) as { k: string; c: string | number }[];
  return rows.map((row) => ({ key: row.k, count: Number(row.c) }));
}

export async function listAttributeValues(
  ch: ClickHouseClient,
  organizationId: string,
  key: string,
  range?: TimeRange,
  limit = 200,
  source?: SeriesSource | "metrics",
  valuePrefix?: string,
  // Counts only rows that also match these filters, such as a dashboard's
  // other variables. A log or span attribute filter leaves out the other table.
  filters?: ResourceAttrFilter[],
): Promise<{ value: string; count: number }[]> {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(range);
  const parsed = parseAttributeKey(key);
  const keyParam = parsed.key;
  const split = splitAttrs(filters);
  const resourceFilter = attrConds(split.resource, "ResourceAttributes", "fattr_r");
  const logFilter = attrConds(split.log, "LogAttributes", "fattr_l");
  const spanFilter = attrConds(split.span, "SpanAttributes", "fattr_s");
  const logFields = fieldConds(split.field, "logs", "fattr_f");
  const traceFields = fieldConds(split.field, "traces", "fattr_f");
  const searchLogs = split.span.length === 0;
  const searchTraces = split.log.length === 0;
  // Capped like listAttributeKeys: grouping the values of a map column across
  // a high-volume window reads as many rows as the key scan did. Counts become
  // approximate, which is fine for ordering the dropdown.
  const valueScan = (table: "otel_logs" | "otel_traces", column: AttributeColumn): string => {
    const conds = [
      ...resourceFilter.conds,
      ...(table === "otel_logs" ? [...logFilter.conds, ...logFields.conds] : [...spanFilter.conds, ...traceFields.conds]),
    ];
    return `
      SELECT v, count() AS c FROM (
        SELECT ${column}[{key:String}] AS v
        FROM ${table}
        WHERE SuperlogProjectId = {organizationId:String}
          AND Timestamp >= ${sinceExpr}
          AND Timestamp <= ${untilExpr}
          AND mapContains(${column}, {key:String})
          ${conds.map((cond) => `AND ${cond}`).join("\n          ")}
        LIMIT ${ATTRIBUTE_KEY_SCAN_ROW_CAP}
      ) GROUP BY v`;
  };
  const subqueries: string[] = [];
  if (parsed.scope === "resource") {
    if (searchLogs && (source === undefined || source === "logs" || source === "metrics")) {
      subqueries.push(valueScan("otel_logs", "ResourceAttributes"));
    }
    if (searchTraces && (source === undefined || source === "traces" || source === "metrics")) {
      subqueries.push(valueScan("otel_traces", "ResourceAttributes"));
    }
  } else if (parsed.scope === "log" && source === "logs" && searchLogs) {
    subqueries.push(valueScan("otel_logs", "LogAttributes"));
  } else if (parsed.scope === "span" && source === "traces" && searchTraces) {
    subqueries.push(valueScan("otel_traces", "SpanAttributes"));
  }
  if (subqueries.length === 0) return [];
  const query = `
    SELECT v, sum(c) AS c FROM (
      ${subqueries.join("\n      UNION ALL\n")}
    )
    WHERE v != ''
      ${valuePrefix ? "AND startsWith(v, {valuePrefix:String})" : ""}
    GROUP BY v
    ORDER BY c DESC
    LIMIT {limit:UInt32}
  `;
  const r = await ch.query({
    query,
    query_params: {
      organizationId,
      key: keyParam,
      since: sinceSql,
      until: untilSql,
      limit,
      ...(valuePrefix ? { valuePrefix } : {}),
      ...resourceFilter.params,
      ...logFilter.params,
      ...spanFilter.params,
      ...traceFields.params,
      ...logFields.params,
    },
    format: "JSONEachRow",
  });
  const rows = (await r.json()) as { v: string; c: string | number }[];
  return rows.map((row) => ({ value: row.v, count: Number(row.c) }));
}

export type MetricKind = "gauge" | "sum" | "histogram" | "exponential_histogram" | "summary";
export type MetricName = { name: string; kind: MetricKind; unit: string };
export type MetricSeriesRow = { bucket: string; group: string; value: number };

export const METRIC_AGGREGATIONS = ["sum", "avg", "min", "max", "p95", "p99"] as const;
export type MetricAggregation = (typeof METRIC_AGGREGATIONS)[number];

function isMissingMetricTableError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /UNKNOWN_TABLE|Unknown table expression identifier|doesn't exist/i.test(err.message)
  );
}

const METRIC_TABLES: { table: string; kind: MetricKind }[] = [
  { table: "otel_metrics_gauge", kind: "gauge" },
  { table: "otel_metrics_sum", kind: "sum" },
  { table: "otel_metrics_histogram", kind: "histogram" },
  { table: "otel_metrics_exp_histogram", kind: "exponential_histogram" },
  { table: "otel_metrics_summary", kind: "summary" },
];

// Default per-kind aggregation when the caller doesn't specify one.
const DEFAULT_AGG_EXPR: Record<MetricKind, string> = {
  gauge: "avg(Value)",
  sum: "sum(Value)",
  histogram: "toFloat64(sum(Count))",
  exponential_histogram: "toFloat64(sum(Count))",
  summary: "avg(Sum)",
};

// Per-aggregation, per-kind ClickHouse expression. `null` means "this aggregation
// is not supported on this metric kind" — we skip the table for that query.
//
// Histograms and summaries have no scalar Value column. We map sum/avg onto the
// rolled-up Sum/Count columns. Explicit and exponential histogram quantiles are
// reconstructed from their bucket arrays; summary quantiles remain unavailable
// because the stored precomputed quantiles cannot be reaggregated correctly.
const AGG_EXPR: Record<MetricAggregation, Partial<Record<MetricKind, string>>> = {
  sum: {
    gauge: "sum(Value)",
    sum: "sum(Value)",
    histogram: "sum(Sum)",
    exponential_histogram: "sum(Sum)",
    summary: "sum(Sum)",
  },
  avg: {
    gauge: "avg(Value)",
    sum: "avg(Value)",
    histogram: "sum(Sum) / nullIf(toFloat64(sum(Count)), 0)",
    exponential_histogram: "sum(Sum) / nullIf(toFloat64(sum(Count)), 0)",
    summary: "sum(Sum) / nullIf(toFloat64(sum(Count)), 0)",
  },
  min: {
    gauge: "min(Value)",
    sum: "min(Value)",
    histogram: "min(Min)",
    exponential_histogram: "min(Min)",
  },
  max: {
    gauge: "max(Value)",
    sum: "max(Value)",
    histogram: "max(Max)",
    exponential_histogram: "max(Max)",
  },
  p95: {
    gauge: "quantile(0.95)(Value)",
    sum: "quantile(0.95)(Value)",
    // histogram handled via ARRAY JOIN path below — see histogramQuantileQuery.
    histogram: "__histogram_quantile__",
    exponential_histogram: "__histogram_quantile__",
  },
  p99: {
    gauge: "quantile(0.99)(Value)",
    sum: "quantile(0.99)(Value)",
    histogram: "__histogram_quantile__",
    exponential_histogram: "__histogram_quantile__",
  },
};

function unixTimestamp64NanoExpr(expr: string): string {
  return `toUnixTimestamp64Nano(toDateTime64(${expr}, 9))`;
}

// Histograms have no scalar Value column — quantiles must be reconstructed from
// BucketCounts + ExplicitBounds. We approximate by treating each bucket's upper
// bound as its representative value (the overflow bucket falls back to Max,
// or the largest finite bound if Max wasn't recorded), then run
// quantileExactWeighted with bucket counts as weights. This biases the result
// up by less than one bucket width — the same approximation Prometheus's
// histogram_quantile uses, minus the within-bucket linear interpolation.
function histogramQuantileQuery(args: {
  table: string;
  step: Step;
  groupExpr: string;
  baseConds: string[];
  sinceExpr: string;
  untilExpr: string;
  bucketCountsExpr: string;
  bucketKeysExpr: string;
  bucketLayoutExpr: string;
  bucketValuesExpr: string;
  q: number;
  rawBucketExpr?: string;
}): string {
  const {
    table,
    step,
    groupExpr,
    baseConds,
    sinceExpr,
    untilExpr,
    bucketCountsExpr,
    bucketKeysExpr,
    bucketLayoutExpr,
    bucketValuesExpr,
    q,
    rawBucketExpr,
  } = args;
  const baseWhere = baseConds.join(" AND ");
  const rawBucket = rawBucketExpr ?? `toStartOfInterval(TimeUnix, INTERVAL ${step.n} ${step.unit})`;
  const stepNs = stepSeconds(step) * 1_000_000_000;
  const sinceNs = unixTimestamp64NanoExpr(sinceExpr);
  const untilNs = unixTimestamp64NanoExpr(untilExpr);
  const predecessorLookbackExpr = `(${sinceExpr}) - INTERVAL 1 DAY`;
  const predecessorLookbackNs = unixTimestamp64NanoExpr(predecessorLookbackExpr);
  const successorLookaheadExpr = `(${untilExpr}) + INTERVAL 1 DAY`;
  const seriesKey = `cityHash64(
    ServiceName,
    MetricName,
    MetricUnit,
    ResourceSchemaUrl,
    ScopeName,
    ScopeVersion,
    toString(ScopeAttributes),
    ScopeSchemaUrl,
    toString(ResourceAttributes),
    toString(Attributes),
    toString(StartTimeUnix)
  )`;
  return `
    SELECT
      bucket,
      group_key,
      quantileExactWeighted(${q})(bucket_value, weight) AS v
    FROM (
      SELECT
        toString(toStartOfInterval(toDateTime(intDiv(sp.1, 1000000000)), INTERVAL ${step.n} ${step.unit})) AS bucket,
        group_key,
        QuantileBucketValues[idx] AS bucket_value,
        toUInt64(round(DeltaBucketCounts[idx] * sp.2 * 1000000)) AS weight
      FROM (
        SELECT
          group_key,
          QuantileBucketValues,
          DeltaBucketCounts,
          if(
            least(b, ${untilNs}) <= greatest(a, ${sinceNs}),
            [],
            arrayMap(
              g -> tuple(
                g,
                (least(b, g + ${stepNs}, ${untilNs}) - greatest(a, g, ${sinceNs})) / dt
              ),
              arrayMap(
                i -> first_bucket + i * ${stepNs},
                range(toUInt32(intDiv(least(b, ${untilNs}) - 1 - first_bucket, ${stepNs}) + 1))
              )
            )
          ) AS spread
        FROM (
          SELECT
            group_key,
            QuantileBucketKeys,
            QuantileBucketValues,
            if(
              series_row = 0,
              QuantileBucketCounts,
              if(
                series_row = 1,
                if(
                  b < ${sinceNs}
                    OR b = toUnixTimestamp64Nano(StartTimeUnix)
                    OR toUnixTimestamp64Nano(StartTimeUnix) < ${predecessorLookbackNs},
                  emptyArrayUInt64(),
                  QuantileBucketCounts
                ),
                if(
                  QuantileBucketLayout = previous_layout
                    AND arrayAll(
                      (key, count) -> count = 0 OR has(QuantileBucketKeys, key),
                      previous_keys,
                      previous_counts
                    ),
                  arrayMap(
                    (key, current) -> if(
                      indexOf(previous_keys, key) = 0,
                      current,
                      if(
                        current >= previous_counts[indexOf(previous_keys, key)],
                        toUInt64(current - previous_counts[indexOf(previous_keys, key)]),
                        toUInt64(0)
                      )
                    ),
                    QuantileBucketKeys,
                    QuantileBucketCounts
                  ),
                  emptyArrayUInt64()
                )
              )
            ) AS DeltaBucketCounts,
            if(
              series_row <= 1,
              toUnixTimestamp64Nano(StartTimeUnix),
              toUnixTimestamp64Nano(previous_time)
            ) AS a,
            b,
            greatest(b - a, 1) AS dt,
            intDiv(greatest(a, ${sinceNs}), ${stepNs}) * ${stepNs} AS first_bucket
          FROM (
            SELECT
              TimeUnix,
              StartTimeUnix,
              QuantileBucketCounts,
              QuantileBucketKeys,
              QuantileBucketLayout,
              QuantileBucketValues,
              ${groupExpr} AS group_key,
              row_number() OVER series AS series_row,
              lagInFrame(QuantileBucketCounts, 1, emptyArrayUInt64()) OVER series AS previous_counts,
              lagInFrame(QuantileBucketKeys, 1, emptyArrayString()) OVER series AS previous_keys,
              lagInFrame(QuantileBucketLayout, 1, '') OVER series AS previous_layout,
              lagInFrame(TimeUnix, 1, TimeUnix) OVER series AS previous_time,
              toUnixTimestamp64Nano(TimeUnix) AS b
            FROM (
              SELECT
                *,
                ${bucketCountsExpr} AS QuantileBucketCounts,
                ${bucketKeysExpr} AS QuantileBucketKeys,
                toString(${bucketLayoutExpr}) AS QuantileBucketLayout,
                ${bucketValuesExpr} AS QuantileBucketValues
              FROM ${table}
              WHERE ${baseWhere}
                AND TimeUnix >= ${sinceExpr}
                AND TimeUnix <= ${untilExpr}
                AND AggregationTemporality = 2

              UNION ALL

              SELECT
                *,
                ${bucketCountsExpr} AS QuantileBucketCounts,
                ${bucketKeysExpr} AS QuantileBucketKeys,
                toString(${bucketLayoutExpr}) AS QuantileBucketLayout,
                ${bucketValuesExpr} AS QuantileBucketValues
              FROM ${table}
              WHERE ${baseWhere}
                AND TimeUnix < ${sinceExpr}
                AND TimeUnix >= ${predecessorLookbackExpr}
                AND AggregationTemporality = 2
              QUALIFY row_number() OVER (
                PARTITION BY ${seriesKey}
                ORDER BY TimeUnix DESC
              ) = 1

              UNION ALL

              SELECT
                *,
                ${bucketCountsExpr} AS QuantileBucketCounts,
                ${bucketKeysExpr} AS QuantileBucketKeys,
                toString(${bucketLayoutExpr}) AS QuantileBucketLayout,
                ${bucketValuesExpr} AS QuantileBucketValues
              FROM ${table}
              WHERE ${baseWhere}
                AND TimeUnix > ${untilExpr}
                AND TimeUnix <= ${successorLookaheadExpr}
                AND StartTimeUnix < ${untilExpr}
                AND AggregationTemporality = 2
              QUALIFY row_number() OVER (
                PARTITION BY ${seriesKey}
                ORDER BY TimeUnix ASC
              ) = 1
            )
            WINDOW series AS (
              PARTITION BY ${seriesKey}
              ORDER BY TimeUnix ASC
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )

            UNION ALL

            SELECT
              TimeUnix,
              StartTimeUnix,
              ${bucketCountsExpr} AS QuantileBucketCounts,
              ${bucketKeysExpr} AS QuantileBucketKeys,
              toString(${bucketLayoutExpr}) AS QuantileBucketLayout,
              ${bucketValuesExpr} AS QuantileBucketValues,
              ${groupExpr} AS group_key,
              -- Delta histograms already contain the interval contribution.
              0 AS series_row,
              emptyArrayUInt64() AS previous_counts,
              emptyArrayString() AS previous_keys,
              '' AS previous_layout,
              StartTimeUnix AS previous_time,
              toUnixTimestamp64Nano(TimeUnix) AS b
            FROM ${table}
            WHERE ${baseWhere}
              AND TimeUnix >= ${sinceExpr}
              AND TimeUnix <= ${successorLookaheadExpr}
              AND StartTimeUnix < ${untilExpr}
              AND AggregationTemporality = 1
          )
        )
      )
      ARRAY JOIN spread AS sp
      ARRAY JOIN arrayEnumerate(DeltaBucketCounts) AS idx
      WHERE DeltaBucketCounts[idx] > 0

      UNION ALL

      SELECT
        toString(${rawBucket}) AS bucket,
        ${groupExpr} AS group_key,
        QuantileBucketValues[idx] AS bucket_value,
        toUInt64(QuantileBucketCounts[idx]) * 1000000 AS weight
      FROM (
        SELECT
          *,
          ${bucketCountsExpr} AS QuantileBucketCounts,
          ${bucketValuesExpr} AS QuantileBucketValues
        FROM ${table}
        WHERE ${baseWhere}
          AND TimeUnix >= ${sinceExpr}
          AND TimeUnix <= ${untilExpr}
          AND AggregationTemporality = 0
      )
      ARRAY JOIN arrayEnumerate(QuantileBucketCounts) AS idx
      WHERE QuantileBucketCounts[idx] > 0
    )
    WHERE weight > 0
    GROUP BY bucket, group_key
    ORDER BY bucket ASC
    LIMIT 10000
  `;
}

// OTel cumulative sums and histogram fields report a running total per stream;
// delta points report the contribution over their declared start/end interval.
// Both must become interval contributions before temporal reaggregation. The
// naive cumulative approach — diff consecutive samples and drop each diff into
// the single bucket the later sample lands in — also produces a "comb" whenever
// the render step is finer than the export interval.
//
// Instead we spread each sample's increase across the wall-clock interval it
// actually covers (previous sample -> this sample), à la Prometheus rate(),
// weighting by how much each render bucket overlaps that interval. A 60s
// increase straddling two 30s buckets contributes ~half to each, so the series
// is continuous. The spread is conservative: the weights for one interval sum
// to its full duration, so the total increase over the range is unchanged —
// only its distribution across buckets is smoothed. When the step is coarser
// than the export interval the whole interval lands in one bucket and this
// collapses back to the plain per-bucket delta.
function temporalityAwareScalarQuery(args: {
  table: string;
  step: Step;
  groupExpr: string;
  baseConds: string[];
  sinceExpr: string;
  untilExpr: string;
  valueExpr: string;
  isMonotonicExpr: string;
  aggregation?: MetricAggregation;
  bucketAnchorNs?: string;
  rawBucketExpr?: string;
  rowLimit?: number | null;
}): string {
  const {
    table,
    step,
    groupExpr,
    baseConds,
    sinceExpr,
    untilExpr,
    valueExpr,
    isMonotonicExpr,
    aggregation = "sum",
    bucketAnchorNs = "0",
    rawBucketExpr,
    rowLimit = 10000,
  } = args;
  const baseWhere = baseConds.join(" AND ");
  const rawBucket = rawBucketExpr ?? `toStartOfInterval(TimeUnix, INTERVAL ${step.n} ${step.unit})`;
  // Bucket arithmetic is done in nanoseconds (TimeUnix is DateTime64) so that
  // sub-second sample intervals aren't quantized away — truncating to whole
  // seconds can collapse a short interval to zero duration and silently drop
  // its increase.
  const stepNs = stepSeconds(step) * 1_000_000_000;
  const sinceNs = unixTimestamp64NanoExpr(sinceExpr);
  const untilNs = unixTimestamp64NanoExpr(untilExpr);
  const predecessorLookbackExpr = `(${sinceExpr}) - INTERVAL 1 DAY`;
  const predecessorLookbackNs = unixTimestamp64NanoExpr(predecessorLookbackExpr);
  const successorLookaheadExpr = `(${untilExpr}) + INTERVAL 1 DAY`;
  const seriesKey = `cityHash64(
    ServiceName,
    MetricName,
    MetricUnit,
    ResourceSchemaUrl,
    ScopeName,
    ScopeVersion,
    toString(ScopeAttributes),
    ScopeSchemaUrl,
    toString(ResourceAttributes),
    toString(Attributes),
    toString(TemporalityIsMonotonic),
    toString(StartTimeUnix)
  )`;
  const aggregationExpr: Record<MetricAggregation, string> = {
    sum: "sum(v)",
    avg: "avg(v)",
    min: "min(v)",
    max: "max(v)",
    p95: "quantile(0.95)(v)",
    p99: "quantile(0.99)(v)",
  };
  return `
    SELECT
      bucket,
      group_key,
      ${aggregationExpr[aggregation]} AS v
    FROM (
      SELECT
        toString(toStartOfInterval(toDateTime(intDiv(sp.1, 1000000000)), INTERVAL ${step.n} ${step.unit})) AS bucket,
        group_key,
        sp.2 AS v
      FROM (
        SELECT
          group_key,
          if(
            least(b, ${untilNs}) <= greatest(a, ${sinceNs})
              OR (
                previous_value IS NULL
                  AND (
                    b < ${sinceNs}
                      OR b = toUnixTimestamp64Nano(StartTimeUnix)
                      OR toUnixTimestamp64Nano(StartTimeUnix) < ${predecessorLookbackNs}
                  )
              ),
            -- A predecessor included only for boundary differencing contributes
            -- nothing itself. A zero-duration first point is an unknown-start
            -- reset, whose initial rate contribution is also zero. A start
            -- outside the bounded predecessor lookback is too old to infer.
            [],
            -- Spread the increase across every step-aligned bucket the interval
            -- (a, b] touches. For a known reset, a is StartTimeUnix and the
            -- implicit previous value is zero.
            arrayMap(
              g -> tuple(
                g,
                delta * (least(b, g + ${stepNs}, ${untilNs}) - greatest(a, g, ${sinceNs})) / dt
              ),
              arrayMap(
                i -> first_bucket + i * ${stepNs},
                range(toUInt32(intDiv(least(b, ${untilNs}) - 1 - first_bucket, ${stepNs}) + 1))
              )
            )
          ) AS spread
        FROM (
          SELECT
            group_key,
            StartTimeUnix,
            TemporalityValue,
            TemporalityIsMonotonic,
            previous_value,
            if(
              previous_value IS NULL,
              TemporalityValue,
              if(
                TemporalityIsMonotonic AND TemporalityValue < previous_value,
                0,
                TemporalityValue - previous_value
              )
            ) AS delta,
            if(
              previous_value IS NULL,
              toUnixTimestamp64Nano(StartTimeUnix),
              toUnixTimestamp64Nano(prev_time)
            ) AS a,
            toUnixTimestamp64Nano(TimeUnix) AS b,
            greatest(b - a, 1) AS dt,
            intDiv(greatest(a, ${sinceNs}) - ${bucketAnchorNs}, ${stepNs}) * ${stepNs} + ${bucketAnchorNs} AS first_bucket
          FROM (
            SELECT
              TimeUnix,
              StartTimeUnix,
              TemporalityValue,
              TemporalityIsMonotonic,
              ${groupExpr} AS group_key,
              lagInFrame(toNullable(TemporalityValue), 1, NULL) OVER series AS previous_value,
              lagInFrame(TimeUnix, 1, TimeUnix) OVER series AS prev_time
            FROM (
              SELECT
                *,
                toFloat64(${valueExpr}) AS TemporalityValue,
                ${isMonotonicExpr} AS TemporalityIsMonotonic
              FROM ${table}
              WHERE ${baseWhere}
                AND TimeUnix >= ${sinceExpr}
                AND TimeUnix <= ${untilExpr}
                AND AggregationTemporality = 2

              UNION ALL

              SELECT
                *,
                toFloat64(${valueExpr}) AS TemporalityValue,
                ${isMonotonicExpr} AS TemporalityIsMonotonic
              FROM ${table}
              WHERE ${baseWhere}
                AND TimeUnix < ${sinceExpr}
                AND TimeUnix >= ${predecessorLookbackExpr}
                AND AggregationTemporality = 2
              QUALIFY row_number() OVER (
                PARTITION BY ${seriesKey}
                ORDER BY TimeUnix DESC
              ) = 1

              UNION ALL

              SELECT
                *,
                toFloat64(${valueExpr}) AS TemporalityValue,
                ${isMonotonicExpr} AS TemporalityIsMonotonic
              FROM ${table}
              WHERE ${baseWhere}
                AND TimeUnix > ${untilExpr}
                AND TimeUnix <= ${successorLookaheadExpr}
                AND StartTimeUnix < ${untilExpr}
                AND AggregationTemporality = 2
              QUALIFY row_number() OVER (
                PARTITION BY ${seriesKey}
                ORDER BY TimeUnix ASC
              ) = 1
            )
            WINDOW series AS (
              PARTITION BY ${seriesKey}
              ORDER BY TimeUnix ASC
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )
          )
        )
      )
      ARRAY JOIN spread AS sp

      UNION ALL

      SELECT
        toString(toStartOfInterval(toDateTime(intDiv(sp.1, 1000000000)), INTERVAL ${step.n} ${step.unit})) AS bucket,
        group_key,
        sp.2 AS v
      FROM (
        SELECT
          group_key,
          if(
            least(b, ${untilNs}) <= greatest(a, ${sinceNs}),
            [],
            arrayMap(
              g -> tuple(
                g,
                TemporalityValue * (least(b, g + ${stepNs}, ${untilNs}) - greatest(a, g, ${sinceNs})) / dt
              ),
              arrayMap(
                i -> first_bucket + i * ${stepNs},
                range(toUInt32(intDiv(least(b, ${untilNs}) - 1 - first_bucket, ${stepNs}) + 1))
              )
            )
          ) AS spread
        FROM (
          SELECT
            toFloat64(${valueExpr}) AS TemporalityValue,
            ${groupExpr} AS group_key,
            toUnixTimestamp64Nano(StartTimeUnix) AS a,
            toUnixTimestamp64Nano(TimeUnix) AS b,
            greatest(b - a, 1) AS dt,
            intDiv(greatest(a, ${sinceNs}) - ${bucketAnchorNs}, ${stepNs}) * ${stepNs} + ${bucketAnchorNs} AS first_bucket
          FROM ${table}
          WHERE ${baseWhere}
            AND TimeUnix >= ${sinceExpr}
            AND TimeUnix <= ${successorLookaheadExpr}
            AND StartTimeUnix < ${untilExpr}
            AND AggregationTemporality = 1
        )
      )
      ARRAY JOIN spread AS sp

      UNION ALL

      SELECT
        toString(${rawBucket}) AS bucket,
        ${groupExpr} AS group_key,
        toFloat64(${valueExpr}) AS v
      FROM ${table}
      WHERE ${baseWhere}
        AND TimeUnix >= ${sinceExpr}
        AND TimeUnix <= ${untilExpr}
        AND AggregationTemporality = 0
    )
    GROUP BY bucket, group_key
    ORDER BY bucket ASC
    ${rowLimit === null ? "" : `LIMIT ${rowLimit}`}
  `;
}

function temporalityAwareHistogramAverageQuery(
  args: Omit<Parameters<typeof temporalityAwareScalarQuery>[0], "valueExpr" | "isMonotonicExpr">,
): string {
  const { rowLimit = 10000, ...scalarArgs } = args;
  const sums = temporalityAwareScalarQuery({
    ...scalarArgs,
    valueExpr: "Sum",
    isMonotonicExpr: "false",
    rowLimit: null,
  });
  const counts = temporalityAwareScalarQuery({
    ...scalarArgs,
    valueExpr: "Count",
    isMonotonicExpr: "true",
    rowLimit: null,
  });
  return `
    SELECT
      sums.bucket AS bucket,
      sums.group_key AS group_key,
      sums.v / nullIf(counts.v, 0) AS v
    FROM (${sums}) AS sums
    INNER JOIN (${counts}) AS counts USING (bucket, group_key)
    ORDER BY bucket ASC
    ${rowLimit === null ? "" : `LIMIT ${rowLimit}`}
  `;
}

// Same shape as traceRollupCoversWindow: the MVs only populate the rollup from
// their creation forward, so until the backfill reaches back past the window
// start for this project, the fast path would silently hide names that only
// occur earlier in the window. A brand-new project with no history before the
// window falls back too, which is fine — it is low-volume and the raw scan is
// fast there.
async function metricNamesRollupCoversWindow(
  ch: ClickHouseClient,
  organizationId: string,
  sinceExpr: string,
  sinceSql: string,
): Promise<boolean> {
  const rows = await retryOneConnectionReset(async () => {
    const r = await ch.query({
      query: `
      SELECT count() AS c
      FROM (
        SELECT 1
        FROM metric_names_per_hour
        WHERE project_id = {organizationId:String} AND hour < ${sinceExpr}
        LIMIT 1
      )
    `,
      query_params: { organizationId, since: sinceSql },
      format: "JSONEachRow",
    });
    return (await r.json()) as { c: string | number }[];
  });
  return Number(rows[0]?.c ?? 0) > 0;
}

const METRIC_KIND_SET = new Set<string>(METRIC_TABLES.map((t) => t.kind));
const METRIC_KIND_ORDER = new Map<string, number>(METRIC_TABLES.map((t, i) => [t.kind, i]));
const METRIC_NAME_SUPPLEMENTAL_SCAN_TIMEOUT_SECONDS = 1;

// Single read over the (project, kind, name, unit, hour) summing rollup —
// milliseconds at any range where the raw per-table GROUP BYs read millions of
// map-column rows. The partial first hour rounds down to its cell boundary so
// names from it are included rather than dropped.
async function listMetricNamesFromRollup(
  ch: ClickHouseClient,
  organizationId: string,
  sinceExpr: string,
  untilExpr: string,
  sinceSql: string,
  untilSql: string,
  limitPerKind: number,
): Promise<CountedMetricName[]> {
  const r = await ch.query({
    query: `
      SELECT kind, name, unit, sum(c) AS total
      FROM metric_names_per_hour
      WHERE project_id = {organizationId:String}
        AND hour >= toStartOfHour(${sinceExpr})
        AND hour <= ${untilExpr}
      GROUP BY kind, name, unit
      ORDER BY total DESC
      LIMIT ${Math.trunc(limitPerKind)} BY kind
    `,
    query_params: { organizationId, since: sinceSql, until: untilSql },
    format: "JSONEachRow",
  });
  const rows = (await r.json()) as {
    kind: string;
    name: string;
    unit: string;
    total: string | number;
  }[];
  // Match the raw path's output order: tables in METRIC_TABLES order, most
  // frequent names first within each. Unknown kinds can't be routed to a
  // series query, so drop them.
  return rows
    .filter((row) => METRIC_KIND_SET.has(row.kind))
    .sort(
      (a, b) =>
        (METRIC_KIND_ORDER.get(a.kind) ?? 0) - (METRIC_KIND_ORDER.get(b.kind) ?? 0) ||
        Number(b.total) - Number(a.total),
    )
    .map((row) => ({ name: row.name, kind: row.kind as MetricKind, points: Number(row.total), unit: row.unit }));
}

// The metric picker lists the busiest 200 names of each kind.
export async function listMetricNames(
  ch: ClickHouseClient,
  organizationId: string,
  range?: TimeRange,
): Promise<MetricName[]> {
  return (await listCountedMetricNames(ch, organizationId, range, 200)).map(({ kind, name, unit }) => ({ kind, name, unit }));
}

// A metric with how many points it has in the window.
type CountedMetricName = MetricName & { points: number };

async function listCountedMetricNames(
  ch: ClickHouseClient,
  organizationId: string,
  range: TimeRange | undefined,
  limitPerKind: number,
): Promise<CountedMetricName[]> {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(range);

  // Fast path: the picker only needs distinct MetricName/MetricUnit pairs, but
  // on the raw tables the project filter is a ResourceAttributes map lookup
  // that no primary-key or partition pruning helps with — on high-volume
  // projects each per-table GROUP BY reads millions of rows (~0.5 GiB of map
  // column) and the per-table scans added up to 10s+ picker loads. Row-capped
  // sampling (à la ATTRIBUTE_KEY_SCAN_ROW_CAP) is not an option: the raw
  // tables sort by (ServiceName, MetricName, ...), so a capped scan
  // systematically drops metrics late in the sort order. The rollup answers
  // exactly, in milliseconds; anything without it falls back to the raw scan.
  if (await tableExists(ch, "metric_names_per_hour")) {
    if (await metricNamesRollupCoversWindow(ch, organizationId, sinceExpr, sinceSql)) {
      // The original rollup predates exponential-histogram support. Keep its
      // fast path for the four covered tables, then supplement it with a short,
      // best-effort exponential-histogram scan. A high-volume raw scan must not
      // make the already-available rollup result fail. De-duplication also makes
      // this forward-safe if a later rollup migration starts populating that kind.
      const [rolledUp, exponentialHistograms] = await Promise.all([
        listMetricNamesFromRollup(ch, organizationId, sinceExpr, untilExpr, sinceSql, untilSql, limitPerKind),
        listMetricNamesFromRawTable(
          ch,
          organizationId,
          sinceExpr,
          untilExpr,
          sinceSql,
          untilSql,
          "otel_metrics_exp_histogram",
          "exponential_histogram",
          {
            bestEffort: true,
            limit: limitPerKind,
            maxExecutionTimeSeconds: METRIC_NAME_SUPPLEMENTAL_SCAN_TIMEOUT_SECONDS,
          },
        ),
      ]);
      const byIdentity = new Map<string, CountedMetricName>();
      for (const metric of [...rolledUp, ...exponentialHistograms]) {
        byIdentity.set(`${metric.kind}\0${metric.name}\0${metric.unit}`, metric);
      }
      return [...byIdentity.values()].sort(
        (a, b) => (METRIC_KIND_ORDER.get(a.kind) ?? 0) - (METRIC_KIND_ORDER.get(b.kind) ?? 0),
      );
    }
  }

  const perTable = await Promise.all(
    METRIC_TABLES.map(({ table, kind }) =>
      listMetricNamesFromRawTable(
        ch,
        organizationId,
        sinceExpr,
        untilExpr,
        sinceSql,
        untilSql,
        table,
        kind,
        { limit: limitPerKind },
      ),
    ),
  );
  return perTable.flat();
}

async function listMetricNamesFromRawTable(
  ch: ClickHouseClient,
  organizationId: string,
  sinceExpr: string,
  untilExpr: string,
  sinceSql: string,
  untilSql: string,
  table: string,
  kind: MetricKind,
  options: { bestEffort?: boolean; limit?: number; maxExecutionTimeSeconds?: number } = {},
): Promise<CountedMetricName[]> {
  try {
    const r = await ch.query({
      query: `
        SELECT MetricName AS name, MetricUnit AS unit, count() AS c
        FROM ${table}
        WHERE ResourceAttributes['superlog.project_id'] = {organizationId:String}
          AND TimeUnix >= ${sinceExpr}
          AND TimeUnix <= ${untilExpr}
        GROUP BY name, unit
        ORDER BY c DESC
        LIMIT ${Math.trunc(options.limit ?? 200)}
      `,
      query_params: { organizationId, since: sinceSql, until: untilSql },
      format: "JSONEachRow",
      ...(options.maxExecutionTimeSeconds
        ? { clickhouse_settings: { max_execution_time: options.maxExecutionTimeSeconds } }
        : {}),
    });
    const rows = (await r.json()) as { name: string; unit: string; c: string | number }[];
    return rows.map((row) => ({ name: row.name, kind, points: Number(row.c), unit: row.unit }));
  } catch (err) {
    if (!options.bestEffort && !isMissingMetricTableError(err)) throw err;
    return [];
  }
}

export type MetricCatalogEntry = MetricName & {
  // Data-point attribute keys, most frequent first.
  attributes: string[];
  description: string;
  // Distinct resource and data-point attribute sets: the lines the metric
  // draws when grouped by everything. Null when details were not read.
  series: number | null;
  services: string[];
  // Whether the details read every point of the metric. Sampled details can
  // miss services, so only complete ones rule a service out.
  servicesComplete: boolean;
};

type MetricDetail = Pick<MetricCatalogEntry, "attributes" | "description" | "series" | "services"> & {
  // Points the details were read from.
  points: number;
};

// Catalog details and dimensions describe metrics; they never decide which
// metrics exist. Their reads sample the window and stop early with what they
// have, so a high-volume project still opens the catalog quickly.
const METRIC_DETAIL_SCAN_ROW_CAP = 1_000_000;
const METRIC_DIMENSION_SCAN_ROW_CAP = 200_000;
// The catalog lists every metric a project sends, within reason.
const METRIC_CATALOG_NAMES_PER_KIND = 5_000;
// Services kept per metric; a list this long may have been cut.
const METRIC_CATALOG_SERVICES = 20;
const METRIC_DETAIL_SCAN_SECONDS = 4;
const METRIC_POINT_COUNT_SECONDS = 1;
const METRIC_DETAIL_SETTINGS = {
  max_execution_time: METRIC_DETAIL_SCAN_SECONDS,
  timeout_overflow_mode: "break",
} as const;

function isMissingDescriptionError(err: unknown): boolean {
  return err instanceof Error && /MetricDescription/u.test(err.message);
}

// Details are kept per name and unit: a name can be sent in several units.
function metricDetailKey(metric: { name: string; unit: string }): string {
  return `${metric.name}\0${metric.unit}`;
}

async function metricDetailsFromTable(
  ch: ClickHouseClient,
  organizationId: string,
  window: { sinceExpr: string; sinceSql: string; untilExpr: string; untilSql: string },
  table: string,
  withDescription = true,
): Promise<{ details: Map<string, MetricDetail>; sampled: boolean }> {
  try {
    const started = Date.now();
    const r = await ch.query({
      query: `
        SELECT
          MetricName AS name,
          MetricUnit AS unit,
          ${withDescription ? "anyIf(MetricDescription, MetricDescription != '')" : "''"} AS description,
          groupUniqArray(${METRIC_CATALOG_SERVICES})(ServiceName) AS services,
          topKArray(30)(mapKeys(Attributes)) AS attributes,
          uniq(ResourceAttributes, Attributes) AS series,
          count() AS points
        FROM (
          SELECT MetricName, MetricUnit, ${withDescription ? "MetricDescription, " : ""}ServiceName, Attributes, ResourceAttributes
          FROM ${table}
          WHERE ResourceAttributes['superlog.project_id'] = {organizationId:String}
            AND TimeUnix >= ${window.sinceExpr}
            AND TimeUnix <= ${window.untilExpr}
          LIMIT ${METRIC_DETAIL_SCAN_ROW_CAP}
        )
        GROUP BY name, unit
      `,
      query_params: { organizationId, since: window.sinceSql, until: window.untilSql },
      format: "JSONEachRow",
      clickhouse_settings: METRIC_DETAIL_SETTINGS,
    });
    const rows = (await r.json()) as {
      attributes: string[];
      description: string;
      name: string;
      points: string | number;
      series: string | number;
      services: string[];
      unit: string;
    }[];
    const details = new Map(
      rows.map((row) => [
        metricDetailKey(row),
        {
          attributes: row.attributes.filter(Boolean),
          description: row.description,
          points: Number(row.points),
          series: Number(row.series),
          services: row.services.filter(Boolean).sort(),
        },
      ]),
    );
    // The scan stopped early when it reached its row cap or its time limit.
    const read = [...details.values()].reduce((total, detail) => total + detail.points, 0);
    const sampled = read >= METRIC_DETAIL_SCAN_ROW_CAP || Date.now() - started >= METRIC_DETAIL_SCAN_SECONDS * 1000 - 250;
    return { details, sampled };
  } catch (err) {
    // Collectors that predate descriptions do not write the column.
    if (withDescription && isMissingDescriptionError(err)) {
      return metricDetailsFromTable(ch, organizationId, window, table, false);
    }
    // Details are optional: without them the metric is still listed.
    return { details: new Map(), sampled: true };
  }
}

// Every metric in the window, with what the catalog shows about each.
export async function listMetricCatalog(
  ch: ClickHouseClient,
  organizationId: string,
  range?: TimeRange,
): Promise<MetricCatalogEntry[]> {
  const window = resolveRange(range);
  const [names, details] = await Promise.all([
    listCountedMetricNames(ch, organizationId, range, METRIC_CATALOG_NAMES_PER_KIND),
    Promise.all(METRIC_TABLES.map(({ table }) => metricDetailsFromTable(ch, organizationId, window, table))),
  ]);
  const detailsByKind = new Map(METRIC_TABLES.map(({ kind }, index) => [kind, details[index]!]));
  return names.flatMap(({ points, ...metric }) => {
    const table = detailsByKind.get(metric.kind);
    const detail = table?.details.get(metricDetailKey(metric));
    // Names counted by the hour can come from before the window starts. A
    // complete scan of the window that found no point of one drops it.
    if (!detail && table && !table.sampled) return [];
    return [{
      ...metric,
      attributes: detail?.attributes ?? [],
      description: detail?.description ?? "",
      series: detail?.series ?? null,
      services: detail?.services ?? [],
      // A scan that stopped early read some metrics only in part. A complete
      // scan read every point, even where the name count, rounded out to whole
      // hours, holds more.
      servicesComplete:
        detail !== undefined &&
        detail.services.length < METRIC_CATALOG_SERVICES &&
        (!table!.sampled || detail.points >= points),
    }];
  });
}

export type MetricDimension = {
  cardinality: number;
  // How a filter or grouping names it: `attr:<key>` for a data-point
  // attribute, `resource.<key>` for a resource attribute.
  key: string;
  name: string;
  scope: "point" | "resource";
  // The most frequent values, each with its share of the points that carry
  // the attribute.
  values: { share: number; value: string }[];
};

// How many points one metric has in the window. The hourly rollup answers in
// milliseconds when it covers the window; it does not cover exponential
// histograms, a window older than its backfill, or every deployment,
// so a short raw count stands in, and a count cut short still thins a busy
// metric. Zero when neither answers, so the caller reads points unthinned.
async function metricPointCount(
  ch: ClickHouseClient,
  organizationId: string,
  metric: { kind: MetricKind; name: string; unit?: string },
  table: string,
  window: { sinceExpr: string; sinceSql: string; untilExpr: string; untilSql: string },
): Promise<number> {
  const query_params = {
    kind: metric.kind,
    metricName: metric.name,
    metricUnit: metric.unit ?? "",
    organizationId,
    since: window.sinceSql,
    until: window.untilSql,
  };
  const count = async (query: string, settings?: { max_execution_time: number; timeout_overflow_mode: "break" }) => {
    try {
      const r = await ch.query({
        query,
        query_params,
        format: "JSONEachRow",
        ...(settings ? { clickhouse_settings: settings } : {}),
      });
      const rows = (await r.json()) as { points: string | number | null }[];
      return Number(rows[0]?.points ?? 0) || 0;
    } catch {
      return 0;
    }
  };
  if (
    (await tableExists(ch, "metric_names_per_hour")) &&
    (await metricNamesRollupCoversWindow(ch, organizationId, window.sinceExpr, window.sinceSql).catch(() => false))
  ) {
    // An hour the window covers in part counts for that part.
    const since = `toFloat64(toUnixTimestamp64Milli(toDateTime64(${window.sinceExpr}, 3))) / 1000`;
    const until = `toFloat64(toUnixTimestamp64Milli(toDateTime64(${window.untilExpr}, 3))) / 1000`;
    const start = "toFloat64(toUnixTimestamp(hour))";
    const rolledUp = await count(`
      SELECT sum(c * greatest(0, least(${start} + 3600, ${until}) - greatest(${start}, ${since})) / 3600) AS points
      FROM metric_names_per_hour
      WHERE project_id = {organizationId:String}
        AND kind = {kind:String}
        AND name = {metricName:String}
        ${metric.unit === undefined ? "" : "AND unit = {metricUnit:String}"}
        AND hour >= toStartOfHour(${window.sinceExpr})
        AND hour <= ${window.untilExpr}
    `);
    if (rolledUp > 0) return rolledUp;
  }
  return count(
    `
      SELECT count() AS points
      FROM ${table}
      WHERE ResourceAttributes['superlog.project_id'] = {organizationId:String}
        AND MetricName = {metricName:String}
        ${metric.unit === undefined ? "" : "AND MetricUnit = {metricUnit:String}"}
        AND TimeUnix >= ${window.sinceExpr}
        AND TimeUnix <= ${window.untilExpr}
    `,
    { max_execution_time: METRIC_POINT_COUNT_SECONDS, timeout_overflow_mode: "break" },
  );
}

// The attributes one metric's points carry, with how many values each takes.
export async function listMetricDimensions(
  ch: ClickHouseClient,
  organizationId: string,
  metric: { kind: MetricKind; name: string; unit?: string },
  range?: TimeRange,
): Promise<MetricDimension[]> {
  const table = METRIC_TABLES.find(({ kind }) => kind === metric.kind)?.table;
  if (!table) return [];
  const window = resolveRange(range);
  const { sinceSql, untilSql, sinceExpr, untilExpr } = window;
  // The tables sort by service and attributes, so the first rows of a scan
  // come from a few services and series. A busy metric keeps every stride-th
  // point by hash instead, so the capped scan spans the whole window.
  const stride = Math.ceil((await metricPointCount(ch, organizationId, metric, table, window)) / METRIC_DIMENSION_SCAN_ROW_CAP);
  try {
    const r = await ch.query({
      query: `
        SELECT
          scope,
          key,
          uniqExact(value) AS cardinality,
          sum(c) AS points,
          arraySlice(arraySort(pair -> -pair.2, groupArray((value, c))), 1, 5) AS top
        FROM (
          SELECT pair.1 AS scope, pair.2 AS key, pair.3 AS value, count() AS c
          FROM (
            SELECT arrayConcat(
              arrayMap((k, v) -> ('point', k, v), mapKeys(Attributes), mapValues(Attributes)),
              arrayMap((k, v) -> ('resource', k, v), mapKeys(ResourceAttributes), mapValues(ResourceAttributes))
            ) AS pairs
            FROM ${table}
            WHERE ResourceAttributes['superlog.project_id'] = {organizationId:String}
              AND MetricName = {metricName:String}
              ${metric.unit === undefined ? "" : "AND MetricUnit = {metricUnit:String}"}
              AND TimeUnix >= ${sinceExpr}
              AND TimeUnix <= ${untilExpr}
              ${stride > 1 ? "AND cityHash64(TimeUnix, ResourceAttributes, Attributes) % {stride:UInt64} = 0" : ""}
            LIMIT ${METRIC_DIMENSION_SCAN_ROW_CAP}
          )
          ARRAY JOIN pairs AS pair
          WHERE NOT (pair.1 = 'resource' AND pair.2 = 'superlog.project_id')
          GROUP BY scope, key, value
        )
        GROUP BY scope, key
        ORDER BY scope = 'resource', points DESC, key
        LIMIT 100
      `,
      query_params: {
        metricName: metric.name,
        metricUnit: metric.unit ?? "",
        organizationId,
        since: sinceSql,
        stride,
        until: untilSql,
      },
      format: "JSONEachRow",
      clickhouse_settings: METRIC_DETAIL_SETTINGS,
    });
    const rows = (await r.json()) as {
      cardinality: string | number;
      key: string;
      points: string | number;
      scope: "point" | "resource";
      top: [string, string | number][];
    }[];
    return rows.map((row) => {
      const points = Number(row.points) || 1;
      return {
        cardinality: Number(row.cardinality),
        key: row.scope === "point" ? `attr:${row.key}` : `resource.${row.key}`,
        name: row.key,
        scope: row.scope,
        values: row.top.map(([value, count]) => ({ share: Number(count) / points, value })),
      };
    });
  } catch (err) {
    if (!isMissingMetricTableError(err)) throw err;
    return [];
  }
}

// Attribute discovery names metric filter keys `resource.<key>`. Metric points
// only carry resource attributes, so drop that scope prefix before reading the
// map. Unscoped keys are resource keys already.
function metricResourceKey(key: string): string {
  return key.startsWith("resource.") ? key.slice("resource.".length) : key;
}

function metricResourceAttrs(
  attrs: ResourceAttrFilter[] | undefined,
): ResourceAttrFilter[] | undefined {
  return attrs?.map((attr) => ({ ...attr, key: metricResourceKey(attr.key) }));
}

// Conditions for metric filters. `attr:<key>` filters a data-point attribute,
// matching how `attr:<key>` groups; any other key is a resource attribute.
function metricAttrConds(attrs: ResourceAttrFilter[] | undefined): {
  conds: string[];
  params: Record<string, string | string[]>;
} {
  const point = (attrs ?? [])
    .filter((attr) => attr.key.startsWith("attr:"))
    .map((attr) => ({ ...attr, key: attr.key.slice("attr:".length) }));
  const resource = attrConds(metricResourceAttrs(attrs?.filter((attr) => !attr.key.startsWith("attr:"))));
  const points = attrConds(point, "Attributes", "pattr");
  return {
    conds: [...resource.conds, ...points.conds],
    params: { ...resource.params, ...points.params },
  };
}

export type MetricSeriesFilter = {
  range?: TimeRange;
  service?: string;
  resourceAttrs?: ResourceAttrFilter[];
};

type MetricSeriesQueryOptions = {
  groupValue?: string;
  bucketAnchorNs?: string;
  // Read only this kind's table, and only points in this unit: a name can be
  // sent as more than one kind or unit.
  kind?: MetricKind;
  unit?: string;
  rawBucketExpr?: string;
  rowLimit?: number | null;
};

export async function metricSeries(
  ch: ClickHouseClient,
  organizationId: string,
  metricName: string,
  filter: MetricSeriesFilter,
  groupBy: string | undefined,
  step: Step,
  aggregation?: MetricAggregation,
  queryOptions: MetricSeriesQueryOptions = {},
): Promise<MetricSeriesRow[]> {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(filter.range);
  const attr = metricAttrConds(filter.resourceAttrs);

  let groupExpr = "''";
  const groupParams: Record<string, string> = {};
  if (groupBy === "service.name" || groupBy === "service") {
    groupExpr = "ServiceName";
  } else if (groupBy?.startsWith("attr:")) {
    // `attr:<key>` groups by metric data-point attributes, not resource
    // attributes — needed when the per-observation dimension differs from
    // the producing service (e.g. `attr:tenant.org.name` for self-emitted
    // gauges that fan out across orgs).
    groupExpr = "Attributes[{groupKey:String}]";
    groupParams.groupKey = groupBy.slice("attr:".length);
  } else if (groupBy) {
    groupExpr = "ResourceAttributes[{groupKey:String}]";
    groupParams.groupKey = metricResourceKey(groupBy);
  }

  const perTable = await Promise.all(
    METRIC_TABLES.map(async ({ table, kind }): Promise<MetricSeriesRow[]> => {
      if (queryOptions.kind && queryOptions.kind !== kind) return [];
      const valueExpr = aggregation ? AGG_EXPR[aggregation][kind] : DEFAULT_AGG_EXPR[kind];
      if (!valueExpr) return [];
      const baseConds: string[] = [
        "ResourceAttributes['superlog.project_id'] = {organizationId:String}",
        "MetricName = {metricName:String}",
        ...attr.conds,
      ];
      if (queryOptions.groupValue !== undefined) {
        baseConds.push(`${groupExpr} = {selectedGroup:String}`);
        groupParams.selectedGroup = queryOptions.groupValue;
      }
      if (filter.service) baseConds.push("ServiceName = {service:String}");
      if (queryOptions.unit !== undefined) baseConds.push("MetricUnit = {metricUnit:String}");
      const conds = [...baseConds, `TimeUnix >= ${sinceExpr}`, `TimeUnix <= ${untilExpr}`];
      // Cumulative histogram min/max describe the entire start-to-current
      // population. They cannot be converted into extrema for the latest
      // interval, so exclude cumulative points while preserving delta and
      // unspecified points as raw observations.
      if (
        (kind === "histogram" || kind === "exponential_histogram") &&
        (aggregation === "min" || aggregation === "max")
      ) {
        conds.push("AggregationTemporality != 2");
      }
      const query =
        (kind === "histogram" || kind === "exponential_histogram") &&
        (aggregation === "p95" || aggregation === "p99")
          ? histogramQuantileQuery({
              table,
              step,
              groupExpr,
              baseConds,
              sinceExpr,
              untilExpr,
              bucketCountsExpr:
                kind === "histogram"
                  ? "BucketCounts"
                  : "arrayConcat(arrayReverse(NegativeBucketCounts), [ZeroCount], PositiveBucketCounts)",
              bucketKeysExpr:
                kind === "histogram"
                  ? "arrayMap(idx -> concat('e:', toString(idx)), arrayEnumerate(BucketCounts))"
                  : `arrayConcat(
                      arrayMap(
                        idx -> concat(
                          'n:',
                          toString(NegativeOffset + length(NegativeBucketCounts) - idx)
                        ),
                        arrayEnumerate(NegativeBucketCounts)
                      ),
                      ['z'],
                      arrayMap(
                        idx -> concat('p:', toString(PositiveOffset + idx - 1)),
                        arrayEnumerate(PositiveBucketCounts)
                      )
                    )`,
              bucketLayoutExpr: kind === "histogram" ? "ExplicitBounds" : "Scale",
              bucketValuesExpr:
                kind === "histogram"
                  ? `arrayMap(
                      idx -> if(
                        idx <= length(ExplicitBounds),
                        ExplicitBounds[idx],
                        if(Max != 0, Max, if(empty(ExplicitBounds), 0, ExplicitBounds[length(ExplicitBounds)]))
                      ),
                      arrayEnumerate(BucketCounts)
                    )`
                  : `arrayConcat(
                      arrayMap(
                        idx -> -pow(
                          2,
                          (NegativeOffset + length(NegativeBucketCounts) - idx) * pow(2, -Scale)
                        ),
                        arrayEnumerate(NegativeBucketCounts)
                      ),
                      [toFloat64(0)],
                      arrayMap(
                        idx -> pow(2, (PositiveOffset + idx) * pow(2, -Scale)),
                        arrayEnumerate(PositiveBucketCounts)
                      )
                    )`,
              q: aggregation === "p95" ? 0.95 : 0.99,
              rawBucketExpr: queryOptions.rawBucketExpr,
            })
          : (kind === "histogram" || kind === "exponential_histogram") && aggregation === "avg"
            ? temporalityAwareHistogramAverageQuery({
                table,
                step,
                groupExpr,
                baseConds,
                sinceExpr,
                untilExpr,
                bucketAnchorNs: queryOptions.bucketAnchorNs,
                rawBucketExpr: queryOptions.rawBucketExpr,
                rowLimit: queryOptions.rowLimit,
              })
            : kind === "sum"
              ? temporalityAwareScalarQuery({
                  table,
                  step,
                  groupExpr,
                  baseConds,
                  sinceExpr,
                  untilExpr,
                  valueExpr: "Value",
                  isMonotonicExpr: "IsMonotonic",
                  aggregation,
                  bucketAnchorNs: queryOptions.bucketAnchorNs,
                  rawBucketExpr: queryOptions.rawBucketExpr,
                  rowLimit: queryOptions.rowLimit,
                })
              : (kind === "histogram" || kind === "exponential_histogram") &&
                  (!aggregation || aggregation === "sum")
                ? temporalityAwareScalarQuery({
                    table,
                    step,
                    groupExpr,
                    baseConds,
                    sinceExpr,
                    untilExpr,
                    valueExpr: aggregation === "sum" ? "Sum" : "Count",
                    isMonotonicExpr: aggregation === "sum" ? "false" : "true",
                    bucketAnchorNs: queryOptions.bucketAnchorNs,
                    rawBucketExpr: queryOptions.rawBucketExpr,
                    rowLimit: queryOptions.rowLimit,
                  })
                : `
          SELECT
            toString(${queryOptions.rawBucketExpr ?? `toStartOfInterval(TimeUnix, INTERVAL ${step.n} ${step.unit})`}) AS bucket,
            ${groupExpr} AS group_key,
            ${valueExpr} AS v
          FROM ${table}
          WHERE ${conds.join(" AND ")}
          GROUP BY bucket, group_key
          ORDER BY bucket ASC
          ${queryOptions.rowLimit === null ? "" : `LIMIT ${queryOptions.rowLimit ?? 10000}`}
        `;
      try {
        const r = await ch.query({
          query,
          query_params: {
            organizationId,
            since: sinceSql,
            until: untilSql,
            metricName,
            metricUnit: queryOptions.unit ?? "",
            service: filter.service ?? "",
            ...attr.params,
            ...groupParams,
          },
          format: "JSONEachRow",
        });
        const rows = (await r.json()) as {
          bucket: string;
          group_key: string;
          v: string | number | null;
        }[];
        const parsed: MetricSeriesRow[] = [];
        for (const row of rows) {
          if (row.v === null) continue;
          const value = Number(row.v);
          if (!Number.isFinite(value)) continue;
          parsed.push({ bucket: row.bucket, group: row.group_key, value });
        }
        return parsed;
      } catch (err) {
        if (!isMissingMetricTableError(err)) throw err;
        return [];
      }
    }),
  );
  const results = perTable.flat();
  results.sort((a, b) => a.bucket.localeCompare(b.bucket));
  return results;
}

export type MetricAggregateRow = { group: string; value: number };

// Aggregate a complete alert/evaluation window directly by group. Anchoring a
// one-day bucket at the requested start keeps every supported alert window in
// one SQL row per group, so the row cap limits groups rather than silently
// truncating time-series buckets. Histogram averages remain count-weighted
// because they use the shared normalized Sum/Count query before this reduction.
export async function metricAggregate(
  ch: ClickHouseClient,
  organizationId: string,
  metricName: string,
  filter: MetricSeriesFilter,
  groupBy: string | undefined,
  aggregation: "sum" | "avg",
  metric: Pick<MetricSeriesQueryOptions, "kind" | "unit"> = {},
): Promise<MetricAggregateRow[]> {
  const { sinceExpr } = resolveRange(filter.range);
  const rows = await metricSeries(
    ch,
    organizationId,
    metricName,
    filter,
    groupBy,
    { n: 1, unit: "DAY" },
    aggregation,
    {
      ...metric,
      bucketAnchorNs: unixTimestamp64NanoExpr(sinceExpr),
      rawBucketExpr: sinceExpr,
      rowLimit: 1000,
    },
  );
  const sums = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const row of rows) {
    sums.set(row.group, (sums.get(row.group) ?? 0) + row.value);
    counts.set(row.group, (counts.get(row.group) ?? 0) + 1);
  }
  return [...sums].map(([group, sum]) => ({
    group,
    value: aggregation === "avg" ? sum / (counts.get(group) ?? 1) : sum,
  }));
}

export type SeriesSource = "logs" | "traces";

export type SeriesFilter = {
  range?: TimeRange;
  service?: string;
  resourceAttrs?: ResourceAttrFilter[];
  search?: string;
  severity?: string;
  spanName?: string;
  statusCode?: string;
  minDurationMs?: number;
  // Spans of traces lasting at least this long, first span start to last span
  // end within the window, as the trace list measures them. `minDurationMs`
  // compares each span's own duration instead.
  minTraceDurationMs?: number;
  // Any of these values, alongside the single-value fields above.
  services?: string[];
  severities?: string[];
  spanNames?: string[];
  statusCodes?: string[];
};

export type StepUnit = "SECOND" | "MINUTE" | "HOUR" | "DAY";
export type Step = { n: number; unit: StepUnit };

const STEP_LADDER: Step[] = [
  { n: 1, unit: "SECOND" },
  { n: 5, unit: "SECOND" },
  { n: 15, unit: "SECOND" },
  { n: 30, unit: "SECOND" },
  { n: 1, unit: "MINUTE" },
  { n: 5, unit: "MINUTE" },
  { n: 15, unit: "MINUTE" },
  { n: 30, unit: "MINUTE" },
  { n: 1, unit: "HOUR" },
  { n: 3, unit: "HOUR" },
  { n: 6, unit: "HOUR" },
  { n: 12, unit: "HOUR" },
  { n: 1, unit: "DAY" },
];

function stepSeconds(step: Step): number {
  const mult =
    step.unit === "SECOND" ? 1 : step.unit === "MINUTE" ? 60 : step.unit === "HOUR" ? 3600 : 86400;
  return step.n * mult;
}

export function pickStep(rangeSeconds: number, targetBuckets = 120): Step {
  const ideal = Math.max(1, rangeSeconds / targetBuckets);
  for (const s of STEP_LADDER) {
    if (stepSeconds(s) >= ideal) return s;
  }
  return STEP_LADDER[STEP_LADDER.length - 1] ?? { n: 1, unit: "DAY" };
}

// -----------------------------------------------------------------------------
// events_per_minute rollup fast path. Count widgets over long ranges were
// scanning the raw tables (and the ResourceAttributes map) for every row in
// the window, which times out for high-volume projects. Queries the rollup
// (see infra/clickhouse/migrations/003_events_per_minute.sql) can answer —
// minute-or-coarser buckets, filters within (service, severity, status_code),
// grouping by nothing or service — read it instead.
//
// Availability is probed once per client and memoized so deployments without
// the rollup (it is not part of the collector's auto-created schema) fall
// back to the raw scan without a per-request penalty.
// -----------------------------------------------------------------------------

const tableExistsMemo = new WeakMap<ClickHouseClient, Map<string, Promise<boolean>>>();

// `EXISTS TABLE <name>` probe, per client + table. Derived tables
// (events_per_minute, otel_traces_summary, …) are not part of the collector's
// auto-created schema, so deployments without them must fall back to the raw
// scan without a per-request penalty. `table` is always a hardcoded literal
// here — never interpolate user input into this.
//
// Only a positive result is cached (a table won't disappear from under a
// running process). A negative or errored probe is NOT cached: it's evicted once
// it resolves so the next call re-probes. This matters because these tables are
// created by a manual migration that can land AFTER the app boots — caching
// "absent" forever would pin the process to the raw scan until it restarts, even
// though the fast path became available. The probe is a cheap metadata lookup,
// and concurrent callers still share the one in-flight promise.
function tableExists(ch: ClickHouseClient, table: string): Promise<boolean> {
  let byTable = tableExistsMemo.get(ch);
  if (!byTable) {
    byTable = new Map();
    tableExistsMemo.set(ch, byTable);
  }
  const cached = byTable.get(table);
  if (cached) return cached;
  const probe = (async () => {
    try {
      const rows = await retryOneConnectionReset(async () => {
        const r = await ch.query({ query: `EXISTS TABLE ${table}`, format: "JSONEachRow" });
        return (await r.json()) as { result: number | string }[];
      });
      return Number(rows[0]?.result) === 1;
    } catch {
      return false;
    }
  })();
  byTable.set(table, probe);
  // Keep only a cached `true`; drop `false`/errored probes so a later call
  // re-checks (self-heals once the migration lands).
  probe
    .then((exists) => {
      if (!exists) byTable?.delete(table);
    })
    .catch(() => byTable?.delete(table));
  return probe;
}

function rollupAvailable(ch: ClickHouseClient): Promise<boolean> {
  return tableExists(ch, "events_per_minute");
}

// A widget that filters on the service.name resource attribute (instead of
// the dedicated service field) is still asking a service question — fold a
// lone equality into `service` so the rollup can answer it. Returns null
// when the filter isn't foldable.
function foldServiceAttrFilter(filter: SeriesFilter): SeriesFilter | null {
  const attrs = filter.resourceAttrs ?? [];
  if (attrs.length === 0) return filter;
  if (attrs.length !== 1 || filter.service) return null;
  const attr = attrs[0];
  if (!attr || attr.values || (attr.op && attr.op !== "eq")) return null;
  const parsed = parseAttributeKey(attr.key);
  if (parsed.scope !== "resource" || parsed.key !== "service.name") return null;
  return { ...filter, service: attr.value, resourceAttrs: [] };
}

function rollupEligible(filter: SeriesFilter, groupBy: string | undefined, step: Step): boolean {
  if (step.unit === "SECOND") return false; // rollup resolution is one minute
  if (filter.resourceAttrs?.length) return false;
  if (filter.search) return false;
  if (filter.spanName || filter.spanNames?.length) return false;
  if (filter.minDurationMs || filter.minTraceDurationMs) return false;
  if (groupBy && !rollupGroupColumn(groupBy)) return false;
  return true;
}

// The rollup column a supported grouping reads.
function rollupGroupColumn(groupBy: string): "service" | "severity" | "status_code" | null {
  if (groupBy === "service" || groupBy === "service.name") return "service";
  if (groupBy === "severity") return "severity";
  if (groupBy === "status") return "status_code";
  return null;
}

async function countSeriesFromRollup(
  ch: ClickHouseClient,
  organizationId: string,
  source: SeriesSource,
  filter: SeriesFilter,
  groupBy: string | undefined,
  step: Step,
): Promise<{ bucket: string; group: string; count: number }[]> {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(filter.range);
  const conds = [
    "project_id = {organizationId:String}",
    "signal = {signal:String}",
    // Rollup cells are whole minutes, so a sub-minute `since` cannot be
    // honored exactly. Round the lower bound down to the cell boundary so the
    // partial first minute is included in full rather than dropped — edge
    // buckets may overcount by up to one minute of data, never undercount.
    // (The upper bound needs no rounding: the cell at until's minute starts
    // at or before `until` and already satisfies <=.) The fast path only
    // serves >= 1-minute chart buckets, so the skew stays within one bucket.
    `minute >= toStartOfMinute(${sinceExpr})`,
    `minute <= ${untilExpr}`,
  ];
  if (filter.service) conds.push("service = {service:String}");
  if (source === "logs") {
    // The rollup stores upper(SeverityText); mirror the raw path's
    // case-insensitive comparison.
    if (filter.severity) conds.push("severity = upper({severity:String})");
  } else if (filter.statusCode) {
    conds.push("status_code = {statusCode:String}");
  }
  const anyOf = anyOfConds([
    { expr: "service", param: "services", values: filter.services },
    ...(source === "logs"
      ? [{ expr: "severity", param: "severities", values: filter.severities?.map((value) => value.toUpperCase()) }]
      : [{ expr: "status_code", param: "statusCodes", values: filter.statusCodes }]),
  ]);
  conds.push(...anyOf.conds);
  const groupColumn = groupBy ? rollupGroupColumn(groupBy) : null;
  // The rollup keeps severity for logs and status codes for spans only.
  const groupExpr =
    groupColumn === "service" ||
    (groupColumn === "severity" && source === "logs") ||
    (groupColumn === "status_code" && source === "traces")
      ? groupColumn
      : "''";

  const query = `
    SELECT
      toString(toStartOfInterval(minute, INTERVAL ${step.n} ${step.unit})) AS bucket,
      ${groupExpr} AS group_key,
      sum(c) AS c
    FROM events_per_minute
    WHERE ${conds.join(" AND ")}
    GROUP BY bucket, group_key
    ORDER BY bucket ASC
    LIMIT 10000
  `;

  const r = await ch.query({
    query,
    query_params: {
      organizationId,
      signal: source,
      since: sinceSql,
      until: untilSql,
      service: filter.service ?? "",
      severity: filter.severity ?? "",
      statusCode: filter.statusCode ?? "",
      ...anyOf.params,
    },
    format: "JSONEachRow",
  });
  const rows = (await r.json()) as { bucket: string; group_key: string; c: string | number }[];
  return rows.map((row) => ({ bucket: row.bucket, group: row.group_key, count: Number(row.c) }));
}

export async function countSeries(
  ch: ClickHouseClient,
  organizationId: string,
  source: SeriesSource,
  filter: SeriesFilter,
  groupBy: string | undefined,
  step: Step,
  groupValue?: string,
): Promise<{ bucket: string; group: string; count: number }[]> {
  const folded = foldServiceAttrFilter(filter);
  if (groupValue === undefined && folded && rollupEligible(folded, groupBy, step) && (await rollupAvailable(ch))) {
    return countSeriesFromRollup(ch, organizationId, source, folded, groupBy, step);
  }
  const { conds, params, table } = countConditions(organizationId, source, filter);
  const group = groupExprForAttribute(groupBy, source);
  if (groupValue !== undefined) {
    conds.push(`${group.expr} = {selectedGroup:String}`);
  }

  const query = `
    SELECT
      toString(toStartOfInterval(Timestamp, INTERVAL ${step.n} ${step.unit})) AS bucket,
      ${group.expr} AS group_key,
      count() AS c
    FROM ${table}
    WHERE ${conds.join(" AND ")}
    GROUP BY bucket, group_key
    ORDER BY bucket ASC
    LIMIT 10000
  `;

  const r = await ch.query({
    query,
    query_params: { ...params, ...group.params, ...(groupValue !== undefined ? { selectedGroup: groupValue } : {}) },
    format: "JSONEachRow",
  });
  const rows = (await r.json()) as { bucket: string; group_key: string; c: string | number }[];
  return rows.map((row) => ({ bucket: row.bucket, group: row.group_key, count: Number(row.c) }));
}

// Filters on raw logs or spans for the window, shared by the count queries.
function countConditions(organizationId: string, source: SeriesSource, filter: SeriesFilter) {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(filter.range);
  const split = splitAttrs(filter.resourceAttrs);
  const attr = attrConds(split.resource);
  const eventAttr =
    source === "logs"
      ? attrConds(split.log, "LogAttributes", "event_attr")
      : attrConds(split.span, "SpanAttributes", "event_attr");
  const field = fieldConds(split.field, source === "logs" ? "logs" : "traces");
  const table = source === "logs" ? "otel_logs" : "otel_traces";
  const anyOf = anyOfConds(
    source === "logs"
      ? [
          { expr: "ServiceName", param: "services", values: filter.services },
          { expr: "upper(SeverityText)", param: "severities", values: filter.severities?.map((value) => value.toUpperCase()) },
        ]
      : [
          { expr: "ServiceName", param: "services", values: filter.services },
          { expr: "SpanName", param: "spanNames", values: filter.spanNames },
          { expr: "StatusCode", param: "statusCodes", values: filter.statusCodes },
        ],
  );
  const conds: string[] = [
    "SuperlogProjectId = {organizationId:String}",
    `Timestamp >= ${sinceExpr}`,
    `Timestamp <= ${untilExpr}`,
    ...attr.conds,
    ...eventAttr.conds,
    ...field.conds,
    ...anyOf.conds,
  ];
  if (filter.service) conds.push("ServiceName = {service:String}");
  if (source === "logs") {
    // otel_logs is partitioned by TimestampTime; bounding it lets the window
    // prune partitions, as in queryLogs.
    conds.push(`TimestampTime >= (${sinceExpr}) - INTERVAL 1 SECOND`, `TimestampTime <= ${untilExpr}`);
    if (filter.severity) conds.push("upper(SeverityText) = upper({severity:String})");
    if (filter.search) conds.push("positionCaseInsensitive(Body, {search:String}) > 0");
  } else {
    if (filter.spanName) conds.push("SpanName = {spanName:String}");
    if (filter.statusCode) conds.push("StatusCode = {statusCode:String}");
    if (typeof filter.minDurationMs === "number") {
      conds.push("Duration >= {minDurationNs:UInt64}");
    }
    if (filter.minTraceDurationMs) {
      conds.push(`TraceId IN (
        SELECT TraceId FROM otel_traces
        WHERE SuperlogProjectId = {organizationId:String}
          AND Timestamp >= ${sinceExpr}
          AND Timestamp <= ${untilExpr}
        GROUP BY TraceId
        HAVING max(toUnixTimestamp64Nano(Timestamp) + Duration) - min(toUnixTimestamp64Nano(Timestamp)) >= {minTraceDurationNs:UInt64}
      )`);
    }
  }

  return {
    conds,
    params: {
      organizationId,
      since: sinceSql,
      until: untilSql,
      service: filter.service ?? "",
      severity: filter.severity ?? "",
      search: filter.search ?? "",
      spanName: filter.spanName ?? "",
      statusCode: filter.statusCode ?? "",
      minDurationNs: Math.round((filter.minDurationMs ?? 0) * 1_000_000),
      minTraceDurationNs: Math.round((filter.minTraceDurationMs ?? 0) * 1_000_000),
      ...attr.params,
      ...eventAttr.params,
      ...field.params,
      ...anyOf.params,
    },
    sinceExpr,
    table,
    untilExpr,
  };
}

// Spans that report token usage and are not the parent of another such span.
// Agent and framework spans often repeat their calls' usage; counting only
// the innermost spans counts each call once.
function aiCallConditions(sinceExpr: string, untilExpr: string): string[] {
  return [
    AI_USAGE_CONDITION,
    `SpanId NOT IN (
      SELECT ParentSpanId FROM otel_traces
      WHERE SuperlogProjectId = {organizationId:String}
        AND Timestamp >= ${sinceExpr}
        AND Timestamp <= ${untilExpr}
        AND ParentSpanId != ''
        AND ${AI_USAGE_CONDITION}
    )`,
  ];
}

// Logs or spans counted per group over exactly the window, from the raw
// tables. The per-minute rollup would count whole boundary minutes. At most
// `limit` groups are returned, largest first.
export async function countAggregate(
  ch: ClickHouseClient,
  organizationId: string,
  source: SeriesSource,
  filter: SeriesFilter,
  groupBy: string | undefined,
  limit: number,
): Promise<{ group: string; value: number }[]> {
  const { conds, params, table } = countConditions(organizationId, source, filter);
  const group = groupExprForAttribute(groupBy, source);
  return retryOneConnectionReset(async () => {
    const r = await ch.query({
      query: `
        SELECT ${group.expr} AS group_key, count() AS c
        FROM ${table}
        WHERE ${conds.join(" AND ")}
        GROUP BY group_key
        ORDER BY c DESC
        LIMIT {limit:UInt32}
      `,
      query_params: { ...params, ...group.params, limit },
      format: "JSONEachRow",
    });
    const rows = (await r.json()) as { group_key: string; c: string | number }[];
    return rows.map((row) => ({ group: row.group_key, value: Number(row.c) }));
  });
}

// How logs or spans are summed up. A count needs no field; the others read a
// number from the field, and a distinct count reads its text.
export const EVENT_AGGREGATIONS = ["count", "count_distinct", "sum", "avg", "min", "max", "p50", "p90", "p95", "p99"] as const;
export type EventAggregation = (typeof EVENT_AGGREGATIONS)[number];
// The field is `duration`, a span's duration in milliseconds, or an attribute
// key as grouping takes it, such as `span.gen_ai.usage.input_tokens`.
export type EventMeasure = { aggregation: EventAggregation; field?: string };

const QUANTILES: Partial<Record<EventAggregation, number>> = { p50: 0.5, p90: 0.9, p95: 0.95, p99: 0.99 };

// Sums and counts add up across groups and buckets; the others do not.
export function isAdditiveAggregation(aggregation: string | undefined): boolean {
  return aggregation === undefined || aggregation === "count" || aggregation === "sum";
}

// The aggregate expression for a measure, and the condition that keeps only
// rows the field has a value on. Null when the field cannot be read from this
// source.
function measureExprs(
  measure: EventMeasure,
  source: SeriesSource,
): { condition: string | null; expr: string; params: Record<string, string> } | null {
  if (measure.aggregation === "count") return { condition: null, expr: "count()", params: {} };
  if (!measure.field) return null;
  if (isAiMeasureField(measure.field)) {
    if (source !== "traces" || measure.aggregation === "count_distinct") return null;
    const number = aiFieldExpr(measure.field);
    const quantile = QUANTILES[measure.aggregation];
    const expr = quantile === undefined ? `${measure.aggregation}(${number})` : `quantile(${quantile})(${number})`;
    return { condition: `isNotNull(${number})`, expr, params: {} };
  }
  let text: string;
  let number: string;
  let params: Record<string, string> = {};
  if (measure.field === "duration") {
    if (source !== "traces") return null;
    text = "toString(Duration)";
    number = "Duration / 1e6";
  } else {
    const attribute = groupExprForAttribute(measure.field, source, "fieldKey");
    if (attribute.expr === "''") return null;
    text = attribute.expr;
    number = `toFloat64OrNull(${attribute.expr})`;
    params = attribute.params;
  }
  if (measure.aggregation === "count_distinct") {
    return { condition: `${text} != ''`, expr: `uniq(${text})`, params };
  }
  const quantile = QUANTILES[measure.aggregation];
  const expr = quantile === undefined ? `${measure.aggregation}(${number})` : `quantile(${quantile})(${number})`;
  return { condition: measure.field === "duration" ? null : `isNotNull(${number})`, expr, params };
}

// The filters, grouping and aggregate for a measure other than a count. An AI
// field reads only model calls, and its cost reads the prices passed in.
function measuredConditions(
  organizationId: string,
  source: SeriesSource,
  filter: SeriesFilter,
  measure: EventMeasure,
  groupBy: string | undefined,
  aiPrices: AiPriceParams | undefined,
) {
  const measured = measureExprs(measure, source);
  if (!measured) return null;
  const { conds, params, sinceExpr, table, untilExpr } = countConditions(organizationId, source, filter);
  const group = groupExprForAttribute(groupBy, source);
  if (measured.condition) conds.push(measured.condition);
  const ai = isAiMeasureField(measure.field);
  if (ai) conds.push(...aiCallConditions(sinceExpr, untilExpr));
  return {
    conds,
    expr: measured.expr,
    group: group.expr,
    params: {
      ...params,
      ...group.params,
      ...measured.params,
      ...(measure.field === "ai:cost" ? (aiPrices ?? emptyAiPriceParams()) : {}),
    },
    table,
  };
}

// The measure per bucket and group. Counts use the per-minute rollup when they
// can; a group with no value in a bucket has no row.
export async function eventSeries(
  ch: ClickHouseClient,
  organizationId: string,
  source: SeriesSource,
  filter: SeriesFilter,
  measure: EventMeasure,
  groupBy: string | undefined,
  step: Step,
  aiPrices?: AiPriceParams,
  groupValue?: string,
): Promise<MetricSeriesRow[]> {
  if (measure.aggregation === "count") {
    const rows = await countSeries(ch, organizationId, source, filter, groupBy, step, groupValue);
    return rows.map((row) => ({ bucket: row.bucket, group: row.group, value: row.count }));
  }
  const measured = measuredConditions(organizationId, source, filter, measure, groupBy, aiPrices);
  if (!measured) return [];
  const { conds, expr, group, params, table } = measured;
  if (groupValue !== undefined) {
    conds.push(`${group} = {selectedGroup:String}`);
  }
  const r = await ch.query({
    query: `
      SELECT
        toString(toStartOfInterval(Timestamp, INTERVAL ${step.n} ${step.unit})) AS bucket,
        ${group} AS group_key,
        ${expr} AS v
      FROM ${table}
      WHERE ${conds.join(" AND ")}
      GROUP BY bucket, group_key
      ORDER BY bucket ASC
      LIMIT 10000
    `,
    query_params: { ...params, ...(groupValue !== undefined ? { selectedGroup: groupValue } : {}) },
    format: "JSONEachRow",
  });
  const rows = (await r.json()) as { bucket: string; group_key: string; v: string | number | null }[];
  return rows.flatMap((row) =>
    row.v === null ? [] : [{ bucket: row.bucket, group: row.group_key, value: Number(row.v) }],
  );
}

// The measure per group over exactly the window, largest first, at most
// `limit` groups. Without grouping there is one row, or none when nothing has
// a value.
export async function eventAggregate(
  ch: ClickHouseClient,
  organizationId: string,
  source: SeriesSource,
  filter: SeriesFilter,
  measure: EventMeasure,
  groupBy: string | undefined,
  limit: number,
  aiPrices?: AiPriceParams,
): Promise<{ group: string; value: number }[]> {
  if (measure.aggregation === "count") return countAggregate(ch, organizationId, source, filter, groupBy, limit);
  const measured = measuredConditions(organizationId, source, filter, measure, groupBy, aiPrices);
  if (!measured) return [];
  const { conds, expr, group, params, table } = measured;
  return retryOneConnectionReset(async () => {
    const r = await ch.query({
      query: `
        SELECT ${group} AS group_key, ${expr} AS v
        FROM ${table}
        WHERE ${conds.join(" AND ")}
        GROUP BY group_key
        ORDER BY v DESC
        LIMIT {limit:UInt32}
      `,
      query_params: { ...params, limit },
      format: "JSONEachRow",
    });
    const rows = (await r.json()) as { group_key: string; v: string | number | null }[];
    return rows.flatMap((row) => (row.v === null ? [] : [{ group: row.group_key, value: Number(row.v) }]));
  });
}

export type AiModelUsage = AiModelKey & {
  calls: number;
  inputTokens: number;
  outputTokens: number;
};

// The models, providers and service tiers of model calls in the window, most
// called first. Spans that only repeat their calls' usage are left out.
export async function aiModelsInWindow(
  ch: ClickHouseClient,
  organizationId: string,
  filter: SeriesFilter,
  limit = 500,
): Promise<AiModelUsage[]> {
  const { conds, params, sinceExpr, untilExpr } = countConditions(organizationId, "traces", filter);
  conds.push(...aiCallConditions(sinceExpr, untilExpr));
  return retryOneConnectionReset(async () => {
    const r = await ch.query({
      query: `
        SELECT
          ${AI_PROVIDER_EXPR} AS provider,
          ${AI_MODEL_EXPR} AS model,
          ${AI_TIER_EXPR} AS tier,
          count() AS calls,
          sum(${aiFieldExpr("ai:tokens.input")}) AS input_tokens,
          sum(${aiFieldExpr("ai:tokens.output")}) AS output_tokens
        FROM otel_traces
        WHERE ${conds.join(" AND ")}
        GROUP BY provider, model, tier
        ORDER BY calls DESC
        LIMIT {limit:UInt32}
      `,
      query_params: { ...params, limit },
      format: "JSONEachRow",
    });
    const rows = (await r.json()) as Array<{
      calls: number | string;
      input_tokens: number | string;
      model: string;
      output_tokens: number | string;
      provider: string;
      tier: string;
    }>;
    return rows.map((row) => ({
      calls: Number(row.calls),
      inputTokens: Number(row.input_tokens),
      model: row.model,
      outputTokens: Number(row.output_tokens),
      provider: row.provider,
      tier: row.tier,
    }));
  });
}

// Model calls in the window whose span reports no token counts, such as an
// OpenAI stream started without usage reporting. Their cost is unknown.
export async function aiCallsWithoutUsage(ch: ClickHouseClient, organizationId: string, filter: SeriesFilter): Promise<number> {
  const { conds, params } = countConditions(organizationId, "traces", filter);
  conds.push(
    "SpanAttributes['gen_ai.operation.name'] IN ('chat', 'text_completion', 'generate_content', 'embeddings')",
    `NOT ${AI_USAGE_CONDITION}`,
  );
  const r = await ch.query({
    query: `SELECT count() AS c FROM otel_traces WHERE ${conds.join(" AND ")}`,
    query_params: params,
    format: "JSONEachRow",
  });
  const rows = (await r.json()) as Array<{ c: number | string }>;
  return Number(rows[0]?.c ?? 0);
}

// One bucket covering any window. Some metric paths align buckets to the
// epoch rather than the window start, so the bucket is long enough that no
// boundary falls between 1970 and 2200.
const WHOLE_WINDOW_STEP: Step = { n: 84_000, unit: "DAY" };

// One metric per group over the whole window, largest first, at most `limit`
// groups. One bucket covers the window, so percentiles and averages are taken
// over every point rather than per bucket.
export async function metricWindowAggregate(
  ch: ClickHouseClient,
  organizationId: string,
  metricName: string,
  filter: MetricSeriesFilter,
  groupBy: string | undefined,
  aggregation: MetricAggregation | undefined,
  limit: number,
  metric: Pick<MetricSeriesQueryOptions, "kind" | "unit"> = {},
): Promise<MetricAggregateRow[]> {
  const { sinceExpr } = resolveRange(filter.range);
  const rows = await metricSeries(ch, organizationId, metricName, filter, groupBy, WHOLE_WINDOW_STEP, aggregation, {
    ...metric,
    bucketAnchorNs: unixTimestamp64NanoExpr(sinceExpr),
    rawBucketExpr: sinceExpr,
    rowLimit: 1000,
  });
  return rows
    .filter((row) => Number.isFinite(row.value))
    .map((row) => ({ group: row.group, value: row.value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

// -----------------------------------------------------------------------------
// Trace overview: how requests into a service behave over the window.
// -----------------------------------------------------------------------------

export type TraceOverviewSeriesRow = { bucket: string; errors: number; p95_ms: number; requests: number };
export type TraceOverviewOperation = { errors: number; name: string; p95_ms: number; requests: number };
export type TraceOverviewDependency = { errors: number; name: string; p95_ms: number; requests: number };
export type TraceOverviewError = {
  first_seen: string;
  message: string;
  service: string;
  span_name: string;
  spans: number;
  traces: number;
};
export type TraceOverview = {
  dependencies: TraceOverviewDependency[];
  errors: TraceOverviewError[];
  operations: TraceOverviewOperation[];
  series: TraceOverviewSeriesRow[];
  totals: { errors: number; p95_ms: number; requests: number };
};

// Requests enter a service through server and consumer spans, or start a
// trace with a root span.
const ENTRY_SPAN_COND =
  "(SpanKind IN ('SPAN_KIND_SERVER', 'SPAN_KIND_CONSUMER') OR ParentSpanId = '')";
const ERROR_SPAN_COND = "StatusCode = 'STATUS_CODE_ERROR'";
// What a client span calls, from the most specific attribute it carries.
const DEPENDENCY_NAME_EXPR = `multiIf(
  SpanAttributes['peer.service'] != '', SpanAttributes['peer.service'],
  SpanAttributes['server.address'] != '', SpanAttributes['server.address'],
  SpanAttributes['net.peer.name'] != '', SpanAttributes['net.peer.name'],
  SpanAttributes['db.system'] != '', SpanAttributes['db.system'],
  SpanName
)`;

export async function traceOverview(
  ch: ClickHouseClient,
  organizationId: string,
  params: { range?: TimeRange; resourceAttrs?: ResourceAttrFilter[]; service?: string; step: Step },
): Promise<TraceOverview> {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(params.range);
  const attr = attrConds(splitAttrs(params.resourceAttrs).resource);
  const conds = [
    "SuperlogProjectId = {organizationId:String}",
    `Timestamp >= ${sinceExpr}`,
    `Timestamp <= ${untilExpr}`,
    ...attr.conds,
  ];
  if (params.service) conds.push("ServiceName = {service:String}");
  const where = conds.join(" AND ");
  const queryParams = {
    organizationId,
    since: sinceSql,
    until: untilSql,
    service: params.service ?? "",
    ...attr.params,
  };
  const read = <Row>(query: string) =>
    retryOneConnectionReset(async () => {
      const r = await ch.query({ query, query_params: queryParams, format: "JSONEachRow" });
      return (await r.json()) as Row[];
    });
  const stats = `
    count() AS requests,
    countIf(${ERROR_SPAN_COND}) AS errors,
    quantile(0.95)(Duration) / 1000000 AS p95_ms`;

  const [totals, series, operations, dependencies, errors] = await Promise.all([
    read<Record<string, string | number>>(`
      SELECT ${stats}
      FROM otel_traces
      WHERE ${where} AND ${ENTRY_SPAN_COND}
    `),
    read<Record<string, string | number>>(`
      SELECT
        toString(toStartOfInterval(Timestamp, INTERVAL ${params.step.n} ${params.step.unit})) AS bucket,
        ${stats}
      FROM otel_traces
      WHERE ${where} AND ${ENTRY_SPAN_COND}
      GROUP BY bucket
      ORDER BY bucket ASC
      LIMIT 10000
    `),
    read<Record<string, string | number>>(`
      SELECT SpanName AS name, ${stats}
      FROM otel_traces
      WHERE ${where} AND ${ENTRY_SPAN_COND}
      GROUP BY name
      ORDER BY errors DESC, requests DESC
      LIMIT 10
    `),
    read<Record<string, string | number>>(`
      SELECT ${DEPENDENCY_NAME_EXPR} AS name, ${stats}
      FROM otel_traces
      WHERE ${where} AND SpanKind = 'SPAN_KIND_CLIENT'
      GROUP BY name
      ORDER BY p95_ms DESC
      LIMIT 8
    `),
    read<Record<string, string | number>>(`
      SELECT
        if(StatusMessage != '', StatusMessage, SpanName) AS message,
        SpanName AS span_name,
        ServiceName AS service,
        count() AS spans,
        uniqExact(TraceId) AS traces,
        toString(min(Timestamp)) AS first_seen
      FROM otel_traces
      WHERE ${where} AND ${ERROR_SPAN_COND}
      GROUP BY message, service, span_name
      ORDER BY traces DESC
      LIMIT 8
    `),
  ]);
  const number = (value: string | number | undefined) => Number(value) || 0;
  const statRow = (row: Record<string, string | number>) => ({
    errors: number(row.errors),
    p95_ms: number(row.p95_ms),
    requests: number(row.requests),
  });
  return {
    dependencies: dependencies.map((row) => ({ name: String(row.name), ...statRow(row) })),
    errors: errors.map((row) => ({
      first_seen: String(row.first_seen),
      message: String(row.message),
      service: String(row.service),
      span_name: String(row.span_name),
      spans: number(row.spans),
      traces: number(row.traces),
    })),
    operations: operations.map((row) => ({ name: String(row.name), ...statRow(row) })),
    series: series.map((row) => ({ bucket: String(row.bucket), ...statRow(row) })),
    totals: totals[0] ? statRow(totals[0]) : { errors: 0, p95_ms: 0, requests: 0 },
  };
}
