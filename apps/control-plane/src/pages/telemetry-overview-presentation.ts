import type {
  OverviewAi,
  OverviewLogBucket,
  OverviewService,
  OverviewTraceBucket,
  TelemetryRange,
} from "../telemetry-api";

export type PillLevel = "empty" | "error" | "ok" | "warning";

export interface OverviewProblem {
  detail: string;
  id: string;
  prompt: string;
  severity: "error" | "warning";
  title: string;
}

export interface AiAttribute {
  key: string;
  note: string;
  state: "found" | "missing" | "partial";
}

export interface AiCostCallout {
  attributes: AiAttribute[];
  detail: string;
  models: Array<{ calls: number; model: string }>;
  prompt: string;
}

const rangeLabels: Record<TelemetryRange, string> = {
  "15m": "the last 15 minutes",
  "1h": "the last hour",
  "6h": "the last 6 hours",
  "24h": "the last 24 hours",
  "7d": "the last 7 days",
};

export function rangeLabel(range: TelemetryRange): string {
  return rangeLabels[range];
}

// Exact below ten thousand, compact above: 9,412, 41.3k, 1.1M.
export function formatCount(value: number): string {
  if (value < 10_000) return value.toLocaleString("en-US");
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, notation: "compact" }).format(value).toLowerCase().replace("m", "M");
}

// A bucket is red when errors are at least 5% of it, and amber when warnings
// or slow requests are at least 10%. An empty bucket received nothing.
function share(part: number, total: number, ratio: number): boolean {
  return part > 0 && part >= Math.max(1, total * ratio);
}

export function logPills(buckets: OverviewLogBucket[]): PillLevel[] {
  return buckets.map((bucket) => {
    if (bucket.total === 0) return "empty";
    if (share(bucket.errors, bucket.total, 0.05)) return "error";
    if (share(bucket.warnings, bucket.total, 0.1)) return "warning";
    return "ok";
  });
}

export function tracePills(buckets: OverviewTraceBucket[]): PillLevel[] {
  return buckets.map((bucket) => {
    if (bucket.total === 0) return "empty";
    if (share(bucket.errors, bucket.total, 0.05)) return "error";
    if (share(bucket.slow, bucket.total, 0.1)) return "warning";
    return "ok";
  });
}

const code = (value: string) => `\`${value}\``;

function noTracesPrompt(service: string): string {
  return [
    `Add OpenTelemetry tracing to the ${code(service)} service. It already sends logs to Superlog, but no traces.`,
    "",
    "1. Use the official OpenTelemetry SDK for this service's language, with automatic instrumentation for its web framework, HTTP clients, database clients and queues.",
    "2. Export traces over OTLP/HTTP through the same endpoint and ingest key the service already uses for logs. Configure the exporter with the standard OTEL_EXPORTER_OTLP_* environment variables.",
    `3. Keep service.name set to ${code(service)} so the traces and logs belong to the same service.`,
    "4. Connect the logger to the active span so each log record carries its trace and span IDs.",
    "5. Start the SDK before the service loads its other modules, and flush it on shutdown.",
    "",
    "Run the service's checks, then summarize what you changed.",
  ].join("\n");
}

function noLogsPrompt(service: string): string {
  return [
    `Send the ${code(service)} service's logs to Superlog with OpenTelemetry. It already sends traces, but no logs.`,
    "",
    "1. Connect the service's existing logger to the OpenTelemetry logs SDK. Keep writing logs to the console.",
    "2. Export logs over OTLP/HTTP through the same endpoint and ingest key the service already uses for traces.",
    `3. Keep service.name set to ${code(service)}.`,
    "4. Make each log record carry the active trace and span IDs, and set its severity.",
    "",
    "Run the service's checks, then summarize what you changed.",
  ].join("\n");
}

function exceptionPrompt(service: string): string {
  return [
    `Make the ${code(service)} service record exception details on its error logs.`,
    "",
    "Superlog groups errors into issues by their exception, and most of this service's error logs carry none.",
    "",
    "1. Find where the service logs errors, including catch blocks and error handlers.",
    "2. Pass the caught error object to the logger instead of only its message, so the OpenTelemetry log record sets exception.type, exception.message and exception.stacktrace.",
    "3. Keep the existing log messages and levels.",
    "",
    "Run the service's checks, then summarize what you changed.",
  ].join("\n");
}

function traceContextPrompt(service: string): string {
  return [
    `Link the ${code(service)} service's logs to its traces.`,
    "",
    "The service sends both logs and traces to Superlog, but most log records carry no trace ID, so a log can't be found from its trace.",
    "",
    "1. Connect the logger to OpenTelemetry so each record written inside a span carries the active trace and span IDs.",
    "2. Check that background jobs and queue consumers start a span before they log.",
    "",
    "Run the service's checks, then summarize what you changed.",
  ].join("\n");
}

function aiUsagePrompt(services: string[], models: string[]): string {
  return [
    `Record token usage on the model calls in ${services.map(code).join(", ")}, so Superlog can price them.`,
    "",
    ...(models.length ? [`The calls use ${models.map(code).join(", ")}.`, ""] : []),
    "1. Find every call to a model provider's API or SDK.",
    "2. Make sure each call runs in an OpenTelemetry span following the GenAI semantic conventions, with gen_ai.operation.name, gen_ai.provider.name and gen_ai.request.model set.",
    "3. When the response arrives, set gen_ai.usage.input_tokens and gen_ai.usage.output_tokens from the provider's usage fields. For streamed responses, ask the provider to include usage in the stream.",
    "4. Prefer the provider's official OpenTelemetry instrumentation where one exists.",
    "",
    "Run the project's checks, then summarize what you changed.",
  ].join("\n");
}

export function serviceProblems(service: OverviewService, range: TelemetryRange): OverviewProblem[] {
  const problems: OverviewProblem[] = [];
  const window = rangeLabel(range);
  const { logs, traces } = service;
  if (logs && !traces) {
    problems.push({
      detail: `It sent ${formatCount(logs.total)} log records but no spans in ${window}. Without traces, a slow or failing request can't be followed through this service.`,
      id: "no-traces",
      prompt: noTracesPrompt(service.name),
      severity: "error",
      title: `No traces from ${service.name}`,
    });
  }
  if (traces && !logs) {
    problems.push({
      detail: `It sent ${formatCount(traces.total)} traces but no log records in ${window}.`,
      id: "no-logs",
      prompt: noLogsPrompt(service.name),
      severity: "warning",
      title: `No logs from ${service.name}`,
    });
  }
  if (logs && logs.errors >= 10 && logs.errorsWithoutException / logs.errors >= 0.5) {
    problems.push({
      detail: `${formatCount(logs.errorsWithoutException)} of ${formatCount(logs.errors)} error logs have no exception type, message or stack trace, so they can't be grouped into issues.`,
      id: "no-exception-details",
      prompt: exceptionPrompt(service.name),
      severity: "warning",
      title: "Error logs have no exception details",
    });
  }
  if (logs && traces && logs.total >= 50 && logs.withTrace / logs.total < 0.5) {
    const unlinked = Math.round(((logs.total - logs.withTrace) / logs.total) * 100);
    problems.push({
      detail: `${unlinked}% of log records carry no trace ID, so they can't be found from their traces.`,
      id: "logs-without-trace",
      prompt: traceContextPrompt(service.name),
      severity: "warning",
      title: "Logs aren't linked to traces",
    });
  }
  return problems;
}

function attribute(key: string, part: number, whole: number): AiAttribute {
  if (part >= whole) return { key, note: "found on every call", state: "found" };
  if (part === 0) return { key, note: "missing", state: "missing" };
  return { key, note: `on ${Math.round((part / whole) * 100)}% of calls`, state: "partial" };
}

function list(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

// Shown when model calls arrive without token usage, so their cost is unknown.
export function aiCostCallout(ai: OverviewAi, range: TelemetryRange): AiCostCallout | null {
  if (ai.callsWithoutUsage === 0) return null;
  const services = ai.services.filter((service) => service.callsWithoutUsage > 0).map((service) => service.service || "unknown_service");
  const callsWithoutUsage = ai.callsWithoutUsage === ai.calls ? "none report" : `${formatCount(ai.callsWithoutUsage)} don't report`;
  return {
    attributes: [
      attribute("gen_ai.request.model", ai.callsWithModel, ai.calls),
      attribute("gen_ai.usage.input_tokens", ai.callsWithInput, ai.calls),
      attribute("gen_ai.usage.output_tokens", ai.callsWithOutput, ai.calls),
    ],
    detail: `${list(services)} made ${formatCount(ai.calls)} model calls in ${rangeLabel(range)}, but ${callsWithoutUsage} token usage. Add the missing attributes and Superlog prices every call by model and service.`,
    models: ai.models.slice(0, 3),
    prompt: aiUsagePrompt(services, ai.models.slice(0, 5).map((model) => model.model)),
  };
}

export function suggestionPrompt(suggestion: { detail: string; subtitle: string; title: string }): string {
  return [`${suggestion.title}.`, "", suggestion.subtitle, "", suggestion.detail.trim(), "", "Make this change, run the project's checks, then summarize what you changed."].join("\n");
}

export function problemCount(services: OverviewService[], range: TelemetryRange): number {
  return services.reduce((count, service) => count + serviceProblems(service, range).length, 0);
}
