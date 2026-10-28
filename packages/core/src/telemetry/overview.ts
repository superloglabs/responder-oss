import type { ClickHouseClient } from "@clickhouse/client";
import {
  AI_EMBEDDINGS_CONDITION,
  AI_FAILED_CONDITION,
  AI_INPUT_REPORTED_CONDITION,
  AI_MODEL_EXPR,
  AI_OUTPUT_REPORTED_CONDITION,
  AI_USAGE_CONDITION,
} from "./ai-cost.js";
import { resolveRange, retryOneConnectionReset, rollupAvailable, type TimeRange } from "./query.js";

// -----------------------------------------------------------------------------
// Telemetry overview: what each service sent over the window, split into equal
// buckets, and how the workspace's model calls report their usage.
// -----------------------------------------------------------------------------

export const OVERVIEW_BUCKETS = 48;
// The most services the overview lists, by volume.
export const OVERVIEW_SERVICE_LIMIT = 50;
// A request at least this long counts as slow.
export const OVERVIEW_SLOW_MS = 1_000;
// How long each detail query may scan raw rows. Two run one after the other
// within the client's 20 second request timeout.
export const OVERVIEW_DETAIL_SECONDS = 8;

export type OverviewLogBucket = { errors: number; total: number; warnings: number };
// Spans, and the requests among them: server, consumer and root spans.
export type OverviewTraceBucket = { errors: number; requests: number; slow: number; total: number };

// A detail is null until telemetryOverviewDetails adds it, and stays null when
// its query ran out of time.
export type OverviewLogs = OverviewLogBucket & {
  buckets: OverviewLogBucket[];
  // Error logs that carry no exception type, message or stack trace.
  errorsWithoutException: number | null;
  // Logs that carry a trace ID.
  withTrace: number | null;
};

export type OverviewTraces = {
  buckets: OverviewTraceBucket[];
  errors: number;
  // Requests that took at least OVERVIEW_SLOW_MS.
  slow: number | null;
  total: number;
};

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
  // Token counts are expected only from calls that did not fail, and output
  // tokens only from those that generate output, not embeddings.
  completedCalls: number;
  completedGenerations: number;
  callsWithInput: number;
  callsWithModel: number;
  callsWithOutput: number;
  // Completed calls that report neither input nor output tokens; their cost
  // is unknown.
  callsWithoutUsage: number;
  models: OverviewAiModel[];
  services: OverviewAiService[];
};

export type TelemetryOverview = {
  ai: OverviewAi | null;
  bucketSeconds: number;
  services: OverviewService[];
};

// Counts by service name; null when the query ran out of time.
export type OverviewDetails = {
  ai: OverviewAi | null;
  errorsWithoutException: Record<string, number> | null;
  requests: Array<{ bucket: number; requests: number; service: string; slow: number }> | null;
  withTrace: Record<string, number> | null;
};

type Row = Record<string, string | number>;

// Log levels by severity number, or by text when the number is unset.
const ERROR_LOG = "(SeverityNumber >= 17 OR upper(SeverityText) IN ('ERROR', 'FATAL', 'CRITICAL', 'ALERT', 'EMERGENCY'))";
const WARNING_LOG = `(NOT ${ERROR_LOG} AND (SeverityNumber BETWEEN 13 AND 16 OR upper(SeverityText) IN ('WARN', 'WARNING')))`;
// The rollup keeps upper(SeverityText) only, so a log that sets SeverityNumber
// without a level name counts toward its service's total but not as an error
// or warning.
const ERROR_SEVERITY = "severity IN ('ERROR', 'FATAL', 'CRITICAL', 'ALERT', 'EMERGENCY')";
const WARNING_SEVERITY = "severity IN ('WARN', 'WARNING')";
// The ClickHouse exporter writes Error; older exporters wrote STATUS_CODE_ERROR.
const ERROR_STATUS = "('Error', 'STATUS_CODE_ERROR')";
const EXCEPTION_LOG =
  "(LogAttributes['exception.type'] != '' OR LogAttributes['exception.message'] != '' OR LogAttributes['exception.stacktrace'] != '')";
// Requests enter a service through server and consumer spans, or start a
// trace with a root span.
const ENTRY_SPAN = "(SpanKind IN ('Server', 'Consumer', 'SPAN_KIND_SERVER', 'SPAN_KIND_CONSUMER') OR ParentSpanId = '')";
// A model call, whether or not it reports its token usage.
const AI_CALL = `(SpanAttributes['gen_ai.operation.name'] IN ('chat', 'text_completion', 'generate_content', 'embeddings') OR ${AI_USAGE_CONDITION})`;
const AI_COMPLETED = `NOT ${AI_FAILED_CONDITION}`;
const AI_GENERATED = `${AI_COMPLETED} AND NOT ${AI_EMBEDDINGS_CONDITION}`;

const number = (value: unknown) => Number(value) || 0;

function overviewWindow(range: Required<TimeRange>, organizationId: string) {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(range);
  const windowSeconds = Math.max(1, (Date.parse(range.until) - Date.parse(range.since)) / 1000);
  const bucketSeconds = Math.max(1, Math.ceil(windowSeconds / OVERVIEW_BUCKETS));
  const bucketOf = (column: string) =>
    `least(intDiv(toUnixTimestamp(${column}) - toUnixTimestamp(${sinceExpr}), {bucketSeconds:UInt32}), ${OVERVIEW_BUCKETS - 1})`;
  const spans = [
    "SuperlogProjectId = {organizationId:String}",
    `Timestamp >= ${sinceExpr}`,
    `Timestamp <= ${untilExpr}`,
  ].join(" AND ");
  return {
    bucketOf,
    bucketSeconds,
    logs: `${spans} AND TimestampTime >= (${sinceExpr}) - INTERVAL 1 SECOND AND TimestampTime <= ${untilExpr}`,
    params: { bucketSeconds, organizationId, since: sinceSql, until: untilSql },
    sinceExpr,
    spans,
    untilExpr,
  };
}

function reader(ch: ClickHouseClient, params: Record<string, unknown>) {
  return (query: string, settings?: { max_execution_time: number }) =>
    retryOneConnectionReset(async () => {
      const r = await ch.query({
        format: "JSONEachRow",
        query,
        query_params: params,
        ...(settings ? { clickhouse_settings: settings } : {}),
      });
      return (await r.json()) as Row[];
    });
}

// What each service sent over the window, split into equal buckets. Counts
// come from the per-minute rollup when the deployment has it: the raw tables
// are not ordered by workspace, so a large workspace's day takes longer to
// scan than a request may wait.
export async function telemetryOverview(
  ch: ClickHouseClient,
  organizationId: string,
  range: Required<TimeRange>,
): Promise<TelemetryOverview> {
  const window = overviewWindow(range, organizationId);
  const read = reader(ch, window.params);
  const rows = (await rollupAvailable(ch))
    ? await read(`
        SELECT
          signal,
          service,
          ${window.bucketOf("minute")} AS bucket,
          sum(c) AS total,
          sumIf(c, if(signal = 'logs', ${ERROR_SEVERITY}, status_code IN ${ERROR_STATUS})) AS errors,
          sumIf(c, signal = 'logs' AND ${WARNING_SEVERITY}) AS warnings,
          toString(max(minute)) AS last_seen
        FROM events_per_minute
        WHERE project_id = {organizationId:String}
          AND signal IN ('logs', 'traces')
          AND minute >= toStartOfMinute(${window.sinceExpr})
          AND minute <= ${window.untilExpr}
        GROUP BY signal, service, bucket
        LIMIT 100000
      `)
    : (
        await Promise.all([
          read(`
            SELECT
              'logs' AS signal,
              ServiceName AS service,
              ${window.bucketOf("Timestamp")} AS bucket,
              count() AS total,
              countIf(${ERROR_LOG}) AS errors,
              countIf(${WARNING_LOG}) AS warnings,
              toString(max(Timestamp)) AS last_seen
            FROM otel_logs
            WHERE ${window.logs}
            GROUP BY service, bucket
            LIMIT 100000
          `),
          read(`
            SELECT
              'traces' AS signal,
              ServiceName AS service,
              ${window.bucketOf("Timestamp")} AS bucket,
              count() AS total,
              countIf(StatusCode IN ${ERROR_STATUS}) AS errors,
              0 AS warnings,
              toString(max(Timestamp)) AS last_seen
            FROM otel_traces
            WHERE ${window.spans}
            GROUP BY service, bucket
            LIMIT 100000
          `),
        ])
      ).flat();
  return { ai: null, bucketSeconds: window.bucketSeconds, services: summarizeServices(rows) };
}

// The counts that need raw rows: slow requests, error logs without exception
// details, logs linked to traces, and model calls. Each query runs under a
// time limit and is left out when it runs out.
export async function telemetryOverviewDetails(
  ch: ClickHouseClient,
  organizationId: string,
  range: Required<TimeRange>,
): Promise<OverviewDetails> {
  const window = overviewWindow(range, organizationId);
  const read = reader(ch, window.params);
  const detail = async (name: string, query: string): Promise<Row[] | null> => {
    try {
      return await read(query, { max_execution_time: OVERVIEW_DETAIL_SECONDS });
    } catch (error) {
      console.warn(
        JSON.stringify({
          detail: name,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "telemetry_overview_detail_skipped",
          organizationId,
        }),
      );
      return null;
    }
  };

  // Two lanes, so the details hold at most two ClickHouse queries at a time.
  const [[requests, exceptions], [ai, traceLinks]] = await Promise.all([
    (async () => [
      await detail(
        "requests",
        `
          SELECT
            ServiceName AS service,
            ${window.bucketOf("Timestamp")} AS bucket,
            count() AS requests,
            countIf(Duration >= ${OVERVIEW_SLOW_MS * 1_000_000}) AS slow
          FROM otel_traces
          WHERE ${window.spans} AND ${ENTRY_SPAN}
          GROUP BY service, bucket
          LIMIT 100000
        `,
      ),
      await detail(
        "errors_without_exception",
        `
          SELECT ServiceName AS service, count() AS c
          FROM otel_logs
          WHERE ${window.logs} AND ${ERROR_LOG} AND NOT ${EXCEPTION_LOG}
          GROUP BY service
        `,
      ),
    ])(),
    (async () => [
      await detail(
        "ai",
        `
          SELECT
            ServiceName AS service,
            ${AI_MODEL_EXPR} AS model,
            count() AS calls,
            countIf(${AI_MODEL_EXPR} != '') AS with_model,
            countIf(${AI_COMPLETED}) AS completed,
            countIf(${AI_GENERATED}) AS generated,
            countIf(${AI_COMPLETED} AND ${AI_INPUT_REPORTED_CONDITION}) AS with_input,
            countIf(${AI_GENERATED} AND ${AI_OUTPUT_REPORTED_CONDITION}) AS with_output,
            countIf(${AI_COMPLETED} AND NOT ${AI_USAGE_CONDITION}) AS without_usage
          FROM otel_traces
          WHERE ${window.spans} AND ${AI_CALL}
          GROUP BY service, model
          ORDER BY calls DESC
          LIMIT 500
        `,
      ),
      await detail(
        "with_trace",
        `
          SELECT ServiceName AS service, countIf(TraceId != '') AS c
          FROM otel_logs
          WHERE ${window.logs}
          GROUP BY service
        `,
      ),
    ])(),
  ]);

  return {
    ai: ai ? summarizeAi(ai) : null,
    errorsWithoutException: exceptions ? countsByService(exceptions) : null,
    requests: requests
      ? requests.map((row) => ({
          bucket: number(row.bucket),
          requests: number(row.requests),
          service: String(row.service ?? ""),
          slow: number(row.slow),
        }))
      : null,
    withTrace: traceLinks ? countsByService(traceLinks) : null,
  };
}

const emptyLogBucket = (): OverviewLogBucket => ({ errors: 0, total: 0, warnings: 0 });
const emptyTraceBucket = (): OverviewTraceBucket => ({ errors: 0, requests: 0, slow: 0, total: 0 });
const bucketIndex = (value: unknown) => Math.min(OVERVIEW_BUCKETS - 1, Math.max(0, Math.trunc(number(value))));
const later = (a: string, b: string) => (b > a ? b : a);

function countsByService(rows: Row[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const name = String(row.service ?? "");
    counts[name] = (counts[name] ?? 0) + number(row.c);
  }
  return counts;
}

export function summarizeServices(rows: Row[]): OverviewService[] {
  const services = new Map<string, OverviewService>();
  for (const row of rows) {
    const name = String(row.service ?? "");
    let entry = services.get(name);
    if (!entry) {
      entry = { lastSeen: "", logs: null, name, traces: null };
      services.set(name, entry);
    }
    const total = number(row.total);
    const errors = number(row.errors);
    if (row.signal === "logs") {
      const logs = (entry.logs ??= {
        ...emptyLogBucket(),
        buckets: Array.from({ length: OVERVIEW_BUCKETS }, emptyLogBucket),
        errorsWithoutException: null,
        withTrace: null,
      });
      const cell = logs.buckets[bucketIndex(row.bucket)]!;
      cell.total += total;
      cell.errors += errors;
      cell.warnings += number(row.warnings);
      logs.total += total;
      logs.errors += errors;
      logs.warnings += number(row.warnings);
    } else {
      const traces = (entry.traces ??= {
        buckets: Array.from({ length: OVERVIEW_BUCKETS }, emptyTraceBucket),
        errors: 0,
        slow: null,
        total: 0,
      });
      const cell = traces.buckets[bucketIndex(row.bucket)]!;
      cell.total += total;
      cell.errors += errors;
      traces.total += total;
      traces.errors += errors;
    }
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
    completedCalls: 0,
    completedGenerations: 0,
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
    ai.completedCalls += number(row.completed);
    ai.completedGenerations += number(row.generated);
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
