import { z } from "zod";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import {
  getTelemetryClient,
  type TelemetryClient,
} from "../../../../packages/core/src/telemetry/client.js";
import {
  listTelemetryServices,
  readTelemetryMetricPoints,
  readTelemetryTrace,
  searchTelemetryLogs,
  searchTelemetrySpans,
  TelemetryReadError,
  telemetryReadRanges,
  type TelemetryReadRange,
} from "../../../../packages/core/src/telemetry/reads.js";
import {
  defineOperation,
  ManagementError,
  type ManagementContext,
} from "./operation.js";

// Read-only access to the workspace's own logs, traces, and metrics. Every
// query is scoped to the caller's workspace by the query layer.

const windowInput = {
  range: z
    .enum(Object.keys(telemetryReadRanges) as [TelemetryReadRange, ...TelemetryReadRange[]])
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
  eventName: z.string().describe("The OpenTelemetry event name, such as `browser.navigation`. Events usually have no body."),
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

async function telemetryClient(context: ManagementContext): Promise<TelemetryClient> {
  const client = getTelemetryClient();
  if (!client || !(await organizationHasCapability(context.organizationId, "telemetry"))) {
    throw new ManagementError(404, "Telemetry is not available in this workspace.", "telemetry_unavailable");
  }
  return client;
}

const errorStatus = { invalid_window: 400, telemetry_query_timeout: 503, trace_not_found: 404 } as const;

async function read<T>(context: ManagementContext, query: (client: TelemetryClient) => Promise<T>): Promise<T> {
  const client = await telemetryClient(context);
  try {
    return await query(client);
  } catch (error) {
    if (!(error instanceof TelemetryReadError)) throw error;
    throw new ManagementError(errorStatus[error.code], error.message, error.code);
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
      search: z.string().max(500).optional().describe("Case-insensitive text in the log body or event name."),
      service,
      severity: z.string().trim().max(40).optional().describe("A level such as `ERROR`, `WARN`, or `INFO`."),
      traceId: z.string().regex(/^[0-9a-fA-F]{32}$/u).optional().describe("Only logs written in this trace."),
    }),
    output: z.object({ logs: z.array(logSchema), since: z.string(), until: z.string() }),
    run: (context, input) =>
      read(context, (client) => searchTelemetryLogs(client, context.organizationId, input, new Date())),
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
    run: (context, input) =>
      read(context, (client) => searchTelemetrySpans(client, context.organizationId, input, new Date())),
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
    run: (context, input) =>
      read(context, (client) => readTelemetryTrace(client, context.organizationId, input.traceId)),
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
    run: (context, input) =>
      read(context, (client) => readTelemetryMetricPoints(client, context.organizationId, input, new Date())),
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
    run: (context, input) =>
      read(context, (client) => listTelemetryServices(client, context.organizationId, input, new Date())),
  }),
];
