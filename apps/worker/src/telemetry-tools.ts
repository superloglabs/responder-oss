import { getTelemetryClient, type TelemetryClient } from "@responder/core/telemetry/client";
import {
  listTelemetryServices,
  readTelemetryMetricPoints,
  readTelemetryTrace,
  searchTelemetryLogs,
  searchTelemetrySpans,
  telemetryReadRanges,
  type TelemetryReadRange,
} from "@responder/core/telemetry/reads";
import { z } from "zod";
import { automationToolServerName } from "./automation-harness.js";
import { workspaceTool, type WorkspaceTool } from "./workspace-tools.js";

// Read-only tools over the workspace's own logs, traces, and metrics, with the
// same names and results as the Superlog MCP server's telemetry tools.

export interface TelemetryToolDependencies {
  client: () => TelemetryClient | null;
  now: () => Date;
}

const defaultDependencies: TelemetryToolDependencies = {
  client: getTelemetryClient,
  now: () => new Date(),
};

// Omitted fields arrive as null.
const windowParameters = {
  range: z
    .enum(Object.keys(telemetryReadRanges) as [TelemetryReadRange, ...TelemetryReadRange[]])
    .nullable()
    .describe("How far back from now to read, when `since` is not given. Defaults to 1h."),
  since: z.iso.datetime({ offset: true }).nullable().describe("Start of the window. Overrides `range`."),
  until: z.iso
    .datetime({ offset: true })
    .nullable()
    .describe("End of the window. Defaults to now. Windows are at most 30 days."),
};
const attributeFilter = z.object({
  key: z.string().trim().min(1).max(200),
  value: z.string().max(500),
});
const resourceAttributes = z
  .array(attributeFilter.extend({
    op: z.enum(["eq", "neq", "not_contains"]).nullish().describe("Defaults to `eq`."),
  }))
  .max(20)
  .nullable()
  .describe("Filters on resource attributes of the service that sent the data, such as `deployment.environment`.");
const service = z.string().trim().min(1).max(200).nullable().describe("Only this `service.name`.");
const limit = (fallback: number) =>
  z.number().int().min(1).max(500).nullable().describe(`Most rows to return. Defaults to ${fallback}.`);
const traceId = z.string().regex(/^[0-9a-fA-F]{32}$/u);

function window(input: { range: TelemetryReadRange | null; since: string | null; until: string | null }) {
  return {
    range: input.range ?? "1h",
    ...(input.since ? { since: input.since } : {}),
    ...(input.until ? { until: input.until } : {}),
  };
}

function resourceFilters(
  filters: Array<{ key: string; op?: "eq" | "neq" | "not_contains" | null | undefined; value: string }> | null,
) {
  return filters?.map(({ key, op, value }) => (op ? { key, op, value } : { key, value })) ?? undefined;
}

function optional<T>(value: T | null): T | undefined {
  return value ?? undefined;
}

// No tools when the cell has no telemetry store.
export function telemetryToolSpecs(
  input: { organizationId: string },
  dependencies: TelemetryToolDependencies = defaultDependencies,
): WorkspaceTool[] {
  const client = dependencies.client();
  if (!client) return [];
  const { organizationId } = input;

  return [
    workspaceTool({
      name: "list_services",
      readOnly: true,
      description: "List the services that sent logs, traces, or metrics to this workspace in a time window.",
      parameters: z.object(windowParameters),
      execute: (request) => listTelemetryServices(client, organizationId, window(request), dependencies.now()),
    }),
    workspaceTool({
      name: "query_logs",
      readOnly: true,
      description:
        "Search this workspace's OpenTelemetry logs in a time window, newest first. Error logs include the recorded exception type, message, and stack trace.",
      parameters: z.object({
        ...windowParameters,
        attributes: z.array(attributeFilter).max(20).nullable()
          .describe("Exact matches on log record attributes, such as `event.name`."),
        limit: limit(50),
        resourceAttributes,
        search: z.string().max(500).nullable().describe("Case-insensitive text in the log body or event name."),
        service,
        severity: z.string().trim().max(40).nullable().describe("A level such as `ERROR`, `WARN`, or `INFO`."),
        traceId: traceId.nullable().describe("Only logs written in this trace."),
      }),
      execute: (request) => searchTelemetryLogs(client, organizationId, {
        ...window(request),
        attributes: optional(request.attributes),
        limit: request.limit ?? 50,
        resourceAttributes: resourceFilters(request.resourceAttributes),
        search: optional(request.search),
        service: optional(request.service),
        severity: optional(request.severity),
        traceId: optional(request.traceId),
      }, dependencies.now()),
    }),
    workspaceTool({
      name: "query_traces",
      readOnly: true,
      description:
        "Search this workspace's OpenTelemetry spans in a time window, newest first. Spans that recorded an exception include its type, message, and stack trace.",
      parameters: z.object({
        ...windowParameters,
        attributes: z.array(attributeFilter).max(20).nullable()
          .describe("Exact matches on span attributes, such as `http.route` or `http.response.status_code`. HTTP status codes live here, not in `statusCode`."),
        limit: limit(50),
        minDurationMs: z.number().min(0).max(3_600_000).nullable().describe("Only spans at least this long."),
        name: z.string().trim().min(1).max(500).nullable().describe("Only spans with this name."),
        resourceAttributes,
        service,
        statusCode: z.enum(["STATUS_CODE_OK", "STATUS_CODE_ERROR", "STATUS_CODE_UNSET"]).nullable()
          .describe("The OpenTelemetry span status. HTTP servers set ERROR only for 5xx responses; 4xx responses stay UNSET."),
      }),
      execute: (request) => searchTelemetrySpans(client, organizationId, {
        ...window(request),
        attributes: optional(request.attributes),
        limit: request.limit ?? 50,
        minDurationMs: optional(request.minDurationMs),
        name: optional(request.name),
        resourceAttributes: resourceFilters(request.resourceAttributes),
        service: optional(request.service),
        statusCode: optional(request.statusCode),
      }, dependencies.now()),
    }),
    workspaceTool({
      name: "get_trace",
      readOnly: true,
      description: "Read every span of one trace in start order, and the logs written during it.",
      parameters: z.object({ traceId: traceId.describe("A 32-character hexadecimal trace ID.") }),
      execute: (request) => readTelemetryTrace(client, organizationId, request.traceId),
    }),
    workspaceTool({
      name: "query_metrics",
      readOnly: true,
      description:
        "Read this workspace's OpenTelemetry metric points in a time window, newest first, across gauges, sums, histograms, and summaries. Gauge and sum points carry a `value`; histogram and summary points carry `count` and `sum` instead.",
      parameters: z.object({
        ...windowParameters,
        limit: limit(100),
        name: z.string().trim().min(1).max(500).nullable().describe("Only this metric."),
        resourceAttributes,
        service,
      }),
      execute: (request) => readTelemetryMetricPoints(client, organizationId, {
        ...window(request),
        limit: request.limit ?? 100,
        name: optional(request.name),
        resourceAttributes: resourceFilters(request.resourceAttributes),
        service: optional(request.service),
      }, dependencies.now()),
    }),
  ];
}

export function telemetryToolInstructions(): string {
  return `This workspace sends its logs, traces, and metrics to Superlog. Read them with the list_services, query_logs, query_traces, get_trace, and query_metrics tools from the ${automationToolServerName} tool server. Call list_services to find service names, start with a short window and filters, and follow a trace ID with get_trace. If a query times out, retry it with a shorter window or more filters.`;
}
