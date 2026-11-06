import type { ClickHouseClient } from "@clickhouse/client";
import {
  getTraceDetail,
  listServices,
  queryLogs,
  queryMetrics,
  queryTraces,
  type ResourceAttrFilter,
  type TimeRange,
} from "./query.js";

// Agent-facing reads of a workspace's own logs, traces, and metrics, shared by
// the management API, its MCP server, and automation runs. Every query is
// scoped to the workspace by the query layer.

export const telemetryReadRanges = { "15m": 15, "1h": 60, "6h": 360, "24h": 1_440, "7d": 10_080 } as const;
export type TelemetryReadRange = keyof typeof telemetryReadRanges;
// A minute to spare for a 30-day window resolved a moment before the request.
const maximumWindowMs = 30 * 86_400_000 + 60_000;

export class TelemetryReadError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_window" | "telemetry_query_timeout" | "trace_not_found",
  ) {
    super(message);
    this.name = "TelemetryReadError";
  }
}

export interface TelemetryReadWindow {
  range: TelemetryReadRange;
  since?: string;
  until?: string;
}

export interface TelemetryAttributeFilter {
  key: string;
  value: string;
}

export type TelemetryResourceFilter = Pick<ResourceAttrFilter, "key" | "op" | "value">;

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

// ClickHouse prints 64-bit integers as strings.
function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function utc(value: unknown): string {
  const timestamp = text(value);
  return /^\d{4}-\d{2}-\d{2} \d/u.test(timestamp) ? `${timestamp.replace(" ", "T")}Z` : timestamp;
}

function attributeMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, text(entry)]));
}

// The workspace tag the ingest endpoint adds is not the sender's own attribute.
function resourceAttributeMap(value: unknown): Record<string, string> {
  const attributes = attributeMap(value);
  delete attributes["superlog.project_id"];
  return attributes;
}

function exceptionOf(row: Row) {
  const type = text(row.exception_type);
  const message = text(row.exception_message);
  const stacktrace = text(row.exception_stacktrace);
  return type || message || stacktrace ? { message, stacktrace, type } : null;
}

function logOf(row: Row) {
  return {
    attributes: attributeMap(row.log_attrs),
    body: text(row.body),
    eventName: text(row.event_name),
    exception: exceptionOf(row),
    resourceAttributes: resourceAttributeMap(row.resource_attrs),
    service: text(row.service),
    severity: text(row.severity),
    severityNumber: numberOrNull(row.severity_number),
    spanId: text(row.span_id),
    timestamp: utc(row.timestamp),
    traceId: text(row.trace_id),
  };
}

function spanOf(row: Row) {
  return {
    attributes: attributeMap(row.span_attrs),
    durationMs: numberOrNull(row.duration_ms) ?? 0,
    exception: exceptionOf(row),
    kind: text(row.span_kind),
    name: text(row.span_name),
    parentSpanId: text(row.parent_span_id),
    resourceAttributes: resourceAttributeMap(row.resource_attrs),
    service: text(row.service),
    spanId: text(row.span_id),
    statusCode: text(row.status_code),
    statusMessage: text(row.status_message),
    timestamp: utc(row.timestamp),
    traceId: text(row.trace_id),
  };
}

export type TelemetryMetricKind = "gauge" | "sum" | "histogram" | "exponential_histogram" | "summary";

function metricPointOf(row: Row) {
  const monotonic = row.is_monotonic;
  return {
    aggregationTemporality: numberOrNull(row.aggregation_temporality),
    attributes: attributeMap(row.attributes),
    count: numberOrNull(row.count),
    isMonotonic: monotonic === null || monotonic === undefined ? null : Boolean(monotonic),
    kind: text(row.kind) as TelemetryMetricKind,
    max: numberOrNull(row.max),
    min: numberOrNull(row.min),
    name: text(row.metric_name),
    resourceAttributes: resourceAttributeMap(row.resource_attrs),
    service: text(row.service),
    startTime: utc(row.start_time),
    sum: numberOrNull(row.sum),
    timestamp: utc(row.timestamp),
    unit: text(row.unit),
    value: numberOrNull(row.value),
  };
}

export function telemetryWindow(input: TelemetryReadWindow, now: Date): Required<TimeRange> {
  const until = input.until === undefined ? now.getTime() : Date.parse(input.until);
  const since = input.since === undefined
    ? until - telemetryReadRanges[input.range] * 60_000
    : Date.parse(input.since);
  if (!(until > since)) {
    throw new TelemetryReadError("`since` must be before `until`.", "invalid_window");
  }
  if (until - since > maximumWindowMs) {
    throw new TelemetryReadError("The window can be at most 30 days.", "invalid_window");
  }
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const details = error as Error & { code?: number | string; type?: string };
  return (
    details.name === "AbortError" ||
    details.name === "TimeoutError" ||
    details.message === "Timeout error." ||
    details.type === "TIMEOUT_EXCEEDED" ||
    details.type === "QUERY_WAS_CANCELLED" ||
    String(details.code) === "159" ||
    String(details.code) === "394"
  );
}

// A query that runs out of time is answered with how to narrow it, so an
// agent can retry instead of giving up.
async function read<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (error) {
    if (!isTimeout(error)) throw error;
    throw new TelemetryReadError(
      "The query did not finish in time. Retry with a shorter window, more filters, or a lower limit.",
      "telemetry_query_timeout",
    );
  }
}

export async function searchTelemetryLogs(
  client: ClickHouseClient,
  organizationId: string,
  input: TelemetryReadWindow & {
    attributes?: TelemetryAttributeFilter[];
    limit: number;
    resourceAttributes?: TelemetryResourceFilter[];
    search?: string;
    service?: string;
    severity?: string;
    traceId?: string;
  },
  now: Date,
) {
  const range = telemetryWindow(input, now);
  const rows = await read(() => queryLogs(client, organizationId, {
    limit: input.limit,
    range,
    ...(input.attributes ? { logAttrs: input.attributes } : {}),
    ...(input.resourceAttributes ? { resourceAttrs: input.resourceAttributes } : {}),
    ...(input.search ? { search: input.search } : {}),
    ...(input.service ? { service: input.service } : {}),
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.traceId ? { traceId: input.traceId.toLowerCase() } : {}),
  }));
  return { logs: (rows as Row[]).map(logOf), ...range };
}

export async function searchTelemetrySpans(
  client: ClickHouseClient,
  organizationId: string,
  input: TelemetryReadWindow & {
    attributes?: TelemetryAttributeFilter[];
    limit: number;
    minDurationMs?: number;
    name?: string;
    resourceAttributes?: TelemetryResourceFilter[];
    service?: string;
    statusCode?: "STATUS_CODE_OK" | "STATUS_CODE_ERROR" | "STATUS_CODE_UNSET";
  },
  now: Date,
) {
  const range = telemetryWindow(input, now);
  const rows = await read(() => queryTraces(client, organizationId, {
    limit: input.limit,
    range,
    ...(input.attributes ? { spanAttrs: input.attributes } : {}),
    ...(input.minDurationMs !== undefined ? { minDurationMs: input.minDurationMs } : {}),
    ...(input.name ? { spanName: input.name } : {}),
    ...(input.resourceAttributes ? { resourceAttrs: input.resourceAttributes } : {}),
    ...(input.service ? { service: input.service } : {}),
    ...(input.statusCode ? { statusCode: input.statusCode } : {}),
  }));
  return { spans: (rows as Row[]).map(spanOf), ...range };
}

export async function readTelemetryTrace(client: ClickHouseClient, organizationId: string, traceId: string) {
  const trace = await read(() => getTraceDetail(client, organizationId, traceId.toLowerCase()));
  if (trace.spans.length === 0) {
    throw new TelemetryReadError("Trace not found", "trace_not_found");
  }
  return {
    logs: (trace.logs as Row[]).map(logOf),
    spans: (trace.spans as Row[]).map(spanOf),
  };
}

export async function readTelemetryMetricPoints(
  client: ClickHouseClient,
  organizationId: string,
  input: TelemetryReadWindow & {
    limit: number;
    name?: string;
    resourceAttributes?: TelemetryResourceFilter[];
    service?: string;
  },
  now: Date,
) {
  const range = telemetryWindow(input, now);
  const rows = await read(() => queryMetrics(client, organizationId, {
    limit: input.limit,
    range,
    ...(input.name ? { metricName: input.name } : {}),
    ...(input.resourceAttributes ? { resourceAttrs: input.resourceAttributes } : {}),
    ...(input.service ? { service: input.service } : {}),
  }));
  return { points: rows.map(metricPointOf), ...range };
}

export async function listTelemetryServices(
  client: ClickHouseClient,
  organizationId: string,
  input: TelemetryReadWindow,
  now: Date,
) {
  const range = telemetryWindow(input, now);
  const services = await read(() => listServices(client, organizationId, range));
  return { services, ...range };
}
