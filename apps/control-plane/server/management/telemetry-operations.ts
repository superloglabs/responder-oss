import { z } from "zod";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import {
  getTelemetryClient,
  type TelemetryClient,
} from "../../../../packages/core/src/telemetry/client.js";
import {
  getTraceDetail,
  listServices,
  queryLogs,
  queryMetrics,
  queryTraces,
  type TimeRange,
} from "../../../../packages/core/src/telemetry/query.js";
import {
  defineOperation,
  ManagementError,
  type ManagementContext,
} from "./operation.js";

// Read-only access to the workspace's own logs, traces, and metrics. Every
// query is scoped to the caller's workspace by the query layer.

const rangeMinutes = { "15m": 15, "1h": 60, "6h": 360, "24h": 1_440, "7d": 10_080 } as const;
type Range = keyof typeof rangeMinutes;
// A minute to spare for a 30-day window resolved a moment before the request.
const maximumWindowMs = 30 * 86_400_000 + 60_000;

const windowInput = {
  range: z
    .enum(Object.keys(rangeMinutes) as [Range, ...Range[]])
    .default("1h")
    .describe("How far back from now to read, when `since` is not given."),
  since: z.iso
    .datetime({ offset: true })
    .optional()
    .describe("Start of the window. Overrides `range`."),
  until: z.iso
    .datetime({ offset: true })
    .optional()
    .describe("End of the window. Defaults to now. Windows are at most 30 days."),
};

const attributeFilter = z.object({
  key: z.string().trim().min(1).max(200),
  value: z.string().max(500),
});
const resourceAttributes = z
  .array(
    attributeFilter.extend({
      op: z
        .enum(["eq", "neq", "not_contains"])
        .optional()
        .describe("Defaults to `eq`."),
    }),
  )
  .max(20)
  .optional()
  .describe(
    "Filters on resource attributes of the service that sent the data, such as `deployment.environment`.",
  );

const service = z.string().trim().min(1).max(200).optional().describe("Only this `service.name`.");
const limit = (fallback: number) =>
  z.number().int().min(1).max(500).default(fallback).describe("Most rows to return.");

const attributes = z.record(z.string(), z.string());
const exception = z
  .object({ message: z.string(), stacktrace: z.string(), type: z.string() })
  .nullable()
  .describe("The recorded exception, when there is one.");

const logSchema = z.object({
  attributes,
  body: z.string(),
  exception,
  resourceAttributes: attributes,
  service: z.string(),
  severity: z.string(),
  severityNumber: z.number().nullable(),
  spanId: z.string(),
  timestamp: z.string().describe("UTC."),
  traceId: z.string(),
});

const spanSchema = z.object({
  attributes,
  durationMs: z.number(),
  exception,
  kind: z.string(),
  name: z.string(),
  parentSpanId: z.string(),
  resourceAttributes: attributes,
  service: z.string(),
  spanId: z.string(),
  statusCode: z.string(),
  statusMessage: z.string(),
  timestamp: z.string().describe("Span start, UTC."),
  traceId: z.string(),
});

const metricPointSchema = z.object({
  aggregationTemporality: z.number().nullable(),
  attributes: attributes.describe("The point's dimensions, such as route or status."),
  count: z.number().nullable().describe("Observations, for histograms and summaries."),
  isMonotonic: z.boolean().nullable(),
  kind: z.enum(["gauge", "sum", "histogram", "exponential_histogram", "summary"]),
  max: z.number().nullable(),
  min: z.number().nullable(),
  name: z.string(),
  resourceAttributes: attributes,
  service: z.string(),
  startTime: z.string().describe("UTC."),
  sum: z.number().nullable().describe("Sum of observations, for histograms and summaries."),
  timestamp: z.string().describe("UTC."),
  unit: z.string(),
  value: z.number().nullable().describe("The value of a gauge or sum point."),
});

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

function metricPointOf(row: Row) {
  const monotonic = row.is_monotonic;
  return {
    aggregationTemporality: numberOrNull(row.aggregation_temporality),
    attributes: attributeMap(row.attributes),
    count: numberOrNull(row.count),
    isMonotonic: monotonic === null || monotonic === undefined ? null : Boolean(monotonic),
    kind: text(row.kind) as z.infer<typeof metricPointSchema>["kind"],
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

export function telemetryWindow(
  input: { range: Range; since?: string | undefined; until?: string | undefined },
  now: Date,
): Required<TimeRange> {
  const until = input.until === undefined ? now.getTime() : Date.parse(input.until);
  const since = input.since === undefined
    ? until - rangeMinutes[input.range] * 60_000
    : Date.parse(input.since);
  if (!(until > since)) {
    throw new ManagementError(400, "`since` must be before `until`.", "invalid_window");
  }
  if (until - since > maximumWindowMs) {
    throw new ManagementError(400, "The window can be at most 30 days.", "invalid_window");
  }
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
}

async function telemetryClient(context: ManagementContext): Promise<TelemetryClient> {
  const client = getTelemetryClient();
  if (!client || !(await organizationHasCapability(context.organizationId, "telemetry"))) {
    throw new ManagementError(404, "Telemetry is not available in this workspace.", "telemetry_unavailable");
  }
  return client;
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
    throw new ManagementError(
      503,
      "The query did not finish in time. Retry with a shorter window, more filters, or a lower limit.",
      "telemetry_query_timeout",
    );
  }
}

export const telemetryOperations = [
  defineOperation({
    name: "query_logs",
    summary: "Search logs",
    description:
      "Returns the workspace's OpenTelemetry logs in a time window, newest first. Error logs include the recorded exception type, message, and stack trace.",
    method: "POST",
    path: "/telemetry/logs/search",
    tag: "Telemetry",
    effect: "read",
    input: z.object({
      ...windowInput,
      attributes: z
        .array(attributeFilter)
        .max(20)
        .optional()
        .describe("Exact matches on log record attributes, such as `event.name`."),
      limit: limit(50),
      resourceAttributes,
      search: z.string().max(500).optional().describe("Case-insensitive text in the log body."),
      service,
      severity: z.string().trim().max(40).optional().describe("A level such as `ERROR`, `WARN`, or `INFO`."),
      traceId: z.string().regex(/^[0-9a-fA-F]{32}$/u).optional().describe("Only logs written in this trace."),
    }),
    output: z.object({ logs: z.array(logSchema), since: z.string(), until: z.string() }),
    async run(context, input) {
      const client = await telemetryClient(context);
      const range = telemetryWindow(input, new Date());
      const rows = await read(() => queryLogs(client, context.organizationId, {
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
    },
  }),
  defineOperation({
    name: "query_traces",
    summary: "Search spans",
    description:
      "Returns the workspace's OpenTelemetry spans in a time window, newest first. Spans that recorded an exception include its type, message, and stack trace.",
    method: "POST",
    path: "/telemetry/traces/search",
    tag: "Telemetry",
    effect: "read",
    input: z.object({
      ...windowInput,
      attributes: z
        .array(attributeFilter)
        .max(20)
        .optional()
        .describe(
          "Exact matches on span attributes, such as `http.route` or `http.response.status_code`. HTTP status codes live here, not in `statusCode`.",
        ),
      limit: limit(50),
      minDurationMs: z.number().min(0).max(3_600_000).optional().describe("Only spans at least this long."),
      name: z.string().trim().min(1).max(500).optional().describe("Only spans with this name."),
      resourceAttributes,
      service,
      statusCode: z
        .enum(["STATUS_CODE_OK", "STATUS_CODE_ERROR", "STATUS_CODE_UNSET"])
        .optional()
        .describe(
          "The OpenTelemetry span status. HTTP servers set ERROR only for 5xx responses; 4xx responses stay UNSET.",
        ),
    }),
    output: z.object({ since: z.string(), spans: z.array(spanSchema), until: z.string() }),
    async run(context, input) {
      const client = await telemetryClient(context);
      const range = telemetryWindow(input, new Date());
      const rows = await read(() => queryTraces(client, context.organizationId, {
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
    },
  }),
  defineOperation({
    name: "get_trace",
    summary: "Get a trace",
    description: "Returns every span of one trace in start order, and the logs written during it.",
    method: "GET",
    path: "/telemetry/traces/{traceId}",
    tag: "Telemetry",
    effect: "read",
    input: z.object({
      traceId: z.string().regex(/^[0-9a-fA-F]{32}$/u).describe("A 32-character hexadecimal trace ID."),
    }),
    output: z.object({ logs: z.array(logSchema), spans: z.array(spanSchema) }),
    async run(context, input) {
      const client = await telemetryClient(context);
      const trace = await read(() => getTraceDetail(client, context.organizationId, input.traceId.toLowerCase()));
      if (trace.spans.length === 0) {
        throw new ManagementError(404, "Trace not found", "trace_not_found");
      }
      return {
        logs: (trace.logs as Row[]).map(logOf),
        spans: (trace.spans as Row[]).map(spanOf),
      };
    },
  }),
  defineOperation({
    name: "query_metrics",
    summary: "Read metric points",
    description:
      "Returns the workspace's recent OpenTelemetry metric points in a time window, newest first, across gauges, sums, histograms, and summaries. Gauge and sum points carry a `value`; histogram and summary points carry `count` and `sum` instead.",
    method: "POST",
    path: "/telemetry/metrics/search",
    tag: "Telemetry",
    effect: "read",
    input: z.object({
      ...windowInput,
      limit: limit(100),
      name: z.string().trim().min(1).max(500).optional().describe("Only this metric."),
      resourceAttributes,
      service,
    }),
    output: z.object({ points: z.array(metricPointSchema), since: z.string(), until: z.string() }),
    async run(context, input) {
      const client = await telemetryClient(context);
      const range = telemetryWindow(input, new Date());
      const rows = await read(() => queryMetrics(client, context.organizationId, {
        limit: input.limit,
        range,
        ...(input.name ? { metricName: input.name } : {}),
        ...(input.resourceAttributes ? { resourceAttrs: input.resourceAttributes } : {}),
        ...(input.service ? { service: input.service } : {}),
      }));
      return { points: rows.map(metricPointOf), ...range };
    },
  }),
  defineOperation({
    name: "list_services",
    summary: "List services",
    description: "Lists the services that sent logs, traces, or metrics in a time window.",
    method: "GET",
    path: "/telemetry/services",
    tag: "Telemetry",
    effect: "read",
    input: z.object(windowInput),
    output: z.object({ services: z.array(z.string()), since: z.string(), until: z.string() }),
    async run(context, input) {
      const client = await telemetryClient(context);
      const range = telemetryWindow(input, new Date());
      const services = await read(() => listServices(client, context.organizationId, range));
      return { services, ...range };
    },
  }),
];
