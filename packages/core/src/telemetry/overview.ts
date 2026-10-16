import type { ClickHouseClient } from "@clickhouse/client";
import {
  AI_INPUT_REPORTED_CONDITION,
  AI_MODEL_EXPR,
  AI_OUTPUT_REPORTED_CONDITION,
  AI_USAGE_CONDITION,
} from "./ai-cost.js";
import { resolveRange, retryOneConnectionReset, type TimeRange } from "./query.js";

// -----------------------------------------------------------------------------
// Telemetry overview: what each service sent over the window, split into equal
// buckets, and how the workspace's model calls report their usage.
// -----------------------------------------------------------------------------

export const OVERVIEW_BUCKETS = 48;
// The most services the overview lists, by volume.
export const OVERVIEW_SERVICE_LIMIT = 50;
// A request at least this long counts as slow.
export const OVERVIEW_SLOW_MS = 1_000;

export type OverviewLogBucket = { errors: number; total: number; warnings: number };
export type OverviewTraceBucket = { errors: number; slow: number; total: number };

export type OverviewLogs = OverviewLogBucket & {
  buckets: OverviewLogBucket[];
  // Error logs that carry no exception type, message or stack trace.
  errorsWithoutException: number;
  // Logs that carry a trace ID.
  withTrace: number;
};

export type OverviewTraces = OverviewTraceBucket & { buckets: OverviewTraceBucket[] };

export type OverviewService = {
  lastSeen: string;
  logs: OverviewLogs | null;
  name: string;
  traces: OverviewTraces | null;
};

export type OverviewAiModel = { calls: number; model: string };
export type OverviewAiService = { calls: number; callsWithoutUsage: number; service: string };

export type OverviewAi = {
  calls: number;
  callsWithInput: number;
  callsWithModel: number;
  callsWithOutput: number;
  // Calls that report neither input nor output tokens; their cost is unknown.
  callsWithoutUsage: number;
  models: OverviewAiModel[];
  services: OverviewAiService[];
};

export type TelemetryOverview = {
  ai: OverviewAi;
  bucketSeconds: number;
  services: OverviewService[];
};

// Log levels by severity number, or by text when the number is unset.
const ERROR_LOG = "(SeverityNumber >= 17 OR upper(SeverityText) IN ('ERROR', 'FATAL', 'CRITICAL', 'ALERT', 'EMERGENCY'))";
const WARNING_LOG = `(NOT ${ERROR_LOG} AND (SeverityNumber BETWEEN 13 AND 16 OR upper(SeverityText) IN ('WARN', 'WARNING')))`;
const EXCEPTION_LOG =
  "(LogAttributes['exception.type'] != '' OR LogAttributes['exception.message'] != '' OR LogAttributes['exception.stacktrace'] != '')";
// Requests enter a service through server and consumer spans, or start a
// trace with a root span.
const ENTRY_SPAN = "(SpanKind IN ('SPAN_KIND_SERVER', 'SPAN_KIND_CONSUMER') OR ParentSpanId = '')";
// A model call, whether or not it reports its token usage.
const AI_CALL = `(SpanAttributes['gen_ai.operation.name'] IN ('chat', 'text_completion', 'generate_content', 'embeddings') OR ${AI_USAGE_CONDITION})`;

const number = (value: unknown) => Number(value) || 0;

export async function telemetryOverview(
  ch: ClickHouseClient,
  organizationId: string,
  range: Required<TimeRange>,
): Promise<TelemetryOverview> {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(range);
  const windowSeconds = Math.max(1, (Date.parse(range.until) - Date.parse(range.since)) / 1000);
  const bucketSeconds = Math.max(1, Math.ceil(windowSeconds / OVERVIEW_BUCKETS));
  const bucket = `least(intDiv(toUnixTimestamp(Timestamp) - toUnixTimestamp(${sinceExpr}), {bucketSeconds:UInt32}), ${OVERVIEW_BUCKETS - 1})`;
  const window = [
    "SuperlogProjectId = {organizationId:String}",
    `Timestamp >= ${sinceExpr}`,
    `Timestamp <= ${untilExpr}`,
  ];
  const params = { bucketSeconds, organizationId, since: sinceSql, until: untilSql };
  const read = <Row>(query: string) =>
    retryOneConnectionReset(async () => {
      const r = await ch.query({ query, query_params: params, format: "JSONEachRow" });
      return (await r.json()) as Row[];
    });

  const [logRows, traceRows, aiRows] = await Promise.all([
    read<Record<string, string | number>>(`
      SELECT
        ServiceName AS service,
        ${bucket} AS bucket,
        count() AS total,
        countIf(${ERROR_LOG}) AS errors,
        countIf(${WARNING_LOG}) AS warnings,
        countIf(${ERROR_LOG} AND NOT ${EXCEPTION_LOG}) AS errors_without_exception,
        countIf(TraceId != '') AS with_trace,
        toString(max(Timestamp)) AS last_seen
      FROM otel_logs
      WHERE ${window.join(" AND ")}
        AND TimestampTime >= (${sinceExpr}) - INTERVAL 1 SECOND
        AND TimestampTime <= ${untilExpr}
      GROUP BY service, bucket
      LIMIT 100000
    `),
    read<Record<string, string | number>>(`
      SELECT
        ServiceName AS service,
        ${bucket} AS bucket,
        uniq(TraceId) AS total,
        uniqIf(TraceId, StatusCode = 'STATUS_CODE_ERROR') AS errors,
        uniqIf(TraceId, ${ENTRY_SPAN} AND Duration >= ${OVERVIEW_SLOW_MS * 1_000_000}) AS slow,
        toString(max(Timestamp)) AS last_seen
      FROM otel_traces
      WHERE ${window.join(" AND ")}
      GROUP BY service, bucket
      LIMIT 100000
    `),
    read<Record<string, string | number>>(`
      SELECT
        ServiceName AS service,
        ${AI_MODEL_EXPR} AS model,
        count() AS calls,
        countIf(${AI_MODEL_EXPR} != '') AS with_model,
        countIf(${AI_INPUT_REPORTED_CONDITION}) AS with_input,
        countIf(${AI_OUTPUT_REPORTED_CONDITION}) AS with_output,
        countIf(NOT ${AI_USAGE_CONDITION}) AS without_usage
      FROM otel_traces
      WHERE ${window.join(" AND ")} AND ${AI_CALL}
      GROUP BY service, model
      ORDER BY calls DESC
      LIMIT 500
    `),
  ]);

  return {
    ai: summarizeAi(aiRows),
    bucketSeconds,
    services: summarizeServices(logRows, traceRows),
  };
}

const emptyLogBucket = (): OverviewLogBucket => ({ errors: 0, total: 0, warnings: 0 });
const emptyTraceBucket = (): OverviewTraceBucket => ({ errors: 0, slow: 0, total: 0 });
const bucketIndex = (value: unknown) => Math.min(OVERVIEW_BUCKETS - 1, Math.max(0, Math.trunc(number(value))));
const later = (a: string, b: string) => (b > a ? b : a);

export function summarizeServices(
  logRows: Array<Record<string, string | number>>,
  traceRows: Array<Record<string, string | number>>,
): OverviewService[] {
  const services = new Map<string, OverviewService>();
  const service = (name: string) => {
    let entry = services.get(name);
    if (!entry) {
      entry = { lastSeen: "", logs: null, name, traces: null };
      services.set(name, entry);
    }
    return entry;
  };
  for (const row of logRows) {
    const entry = service(String(row.service ?? ""));
    const logs = (entry.logs ??= {
      ...emptyLogBucket(),
      buckets: Array.from({ length: OVERVIEW_BUCKETS }, emptyLogBucket),
      errorsWithoutException: 0,
      withTrace: 0,
    });
    const cell = logs.buckets[bucketIndex(row.bucket)]!;
    cell.total += number(row.total);
    cell.errors += number(row.errors);
    cell.warnings += number(row.warnings);
    logs.total += number(row.total);
    logs.errors += number(row.errors);
    logs.warnings += number(row.warnings);
    logs.errorsWithoutException += number(row.errors_without_exception);
    logs.withTrace += number(row.with_trace);
    entry.lastSeen = later(entry.lastSeen, String(row.last_seen ?? ""));
  }
  for (const row of traceRows) {
    const entry = service(String(row.service ?? ""));
    const traces = (entry.traces ??= {
      ...emptyTraceBucket(),
      buckets: Array.from({ length: OVERVIEW_BUCKETS }, emptyTraceBucket),
    });
    const cell = traces.buckets[bucketIndex(row.bucket)]!;
    cell.total += number(row.total);
    cell.errors += number(row.errors);
    cell.slow += number(row.slow);
    traces.total += number(row.total);
    traces.errors += number(row.errors);
    traces.slow += number(row.slow);
    entry.lastSeen = later(entry.lastSeen, String(row.last_seen ?? ""));
  }
  const volume = (entry: OverviewService) => (entry.logs?.total ?? 0) + (entry.traces?.total ?? 0);
  return [...services.values()]
    .sort((a, b) => volume(b) - volume(a) || a.name.localeCompare(b.name))
    .slice(0, OVERVIEW_SERVICE_LIMIT);
}

export function summarizeAi(rows: Array<Record<string, string | number>>): OverviewAi {
  const models = new Map<string, number>();
  const services = new Map<string, OverviewAiService>();
  const ai: OverviewAi = {
    calls: 0,
    callsWithInput: 0,
    callsWithModel: 0,
    callsWithOutput: 0,
    callsWithoutUsage: 0,
    models: [],
    services: [],
  };
  for (const row of rows) {
    const calls = number(row.calls);
    const withoutUsage = number(row.without_usage);
    ai.calls += calls;
    ai.callsWithInput += number(row.with_input);
    ai.callsWithModel += number(row.with_model);
    ai.callsWithOutput += number(row.with_output);
    ai.callsWithoutUsage += withoutUsage;
    const model = String(row.model ?? "");
    if (model) models.set(model, (models.get(model) ?? 0) + calls);
    const name = String(row.service ?? "");
    const service = services.get(name) ?? { calls: 0, callsWithoutUsage: 0, service: name };
    service.calls += calls;
    service.callsWithoutUsage += withoutUsage;
    services.set(name, service);
  }
  ai.models = [...models].map(([model, calls]) => ({ calls, model })).sort((a, b) => b.calls - a.calls);
  ai.services = [...services.values()].sort((a, b) => b.calls - a.calls);
  return ai;
}
