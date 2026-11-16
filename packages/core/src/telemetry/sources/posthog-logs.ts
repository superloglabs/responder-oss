import {
  attribute,
  attributes,
  hexId,
  millisToNanos,
  objectOrEmpty,
  type OtlpKeyValue,
  type OtlpLogRecord,
  type OtlpLogsRequest,
  rfc3339ToNanos,
} from "./otlp-json.js";

// PostHog Logs lines as Superlog stores them. PostHog receives OpenTelemetry
// logs, so a line keeps its own attributes and resource; the converter only
// restores the OTLP encoding of its IDs and severity.
// https://posthog.com/docs/logs

export interface PostHogLogLine {
  attributes?: Record<string, unknown> | null;
  body?: unknown;
  instrumentation_scope?: string | null;
  resource_attributes?: Record<string, unknown> | null;
  resource_fingerprint?: string | null;
  severity_number?: number | null;
  severity_text?: string | null;
  span_id?: string | null;
  timestamp: string;
  trace_id?: string | null;
  uuid: string;
}

export interface PostHogLogContext {
  projectId: string;
  projectName?: string;
}

// PostHog keeps only these severity names.
const severities: Record<string, { number: number; text: string }> = {
  debug: { number: 5, text: "DEBUG" },
  error: { number: 17, text: "ERROR" },
  fatal: { number: 21, text: "FATAL" },
  info: { number: 9, text: "INFO" },
  trace: { number: 1, text: "TRACE" },
  warn: { number: 13, text: "WARN" },
};

// PostHog stores trace and span IDs as base64 bytes, and an unset ID as
// zeros. OTLP JSON wants lowercase hex.
export function postHogId(value: unknown, length: 16 | 32): string | undefined {
  const hex = hexId(value, length) ?? (typeof value === "string" && value
    ? Buffer.from(value, "base64").toString("hex")
    : undefined);
  if (!hex || hex.length !== length || /^0+$/u.test(hex)) return undefined;
  return hexId(hex, length);
}

function bodyValue(body: unknown): OtlpLogRecord["body"] {
  if (typeof body === "string") return { stringValue: body };
  return attribute("body", body)?.value ?? { stringValue: "" };
}

function logRecord(line: PostHogLogLine, observed: string): OtlpLogRecord {
  const named = severities[(line.severity_text ?? "").toLowerCase()] ?? severities.info!;
  const traceId = postHogId(line.trace_id, 32);
  const spanId = postHogId(line.span_id, 16);
  return {
    attributes: attributes(
      ...Object.entries(objectOrEmpty(line.attributes)).map(([key, value]) => attribute(key, value)),
      attribute("posthog.log.uuid", line.uuid),
    ),
    body: bodyValue(line.body),
    observedTimeUnixNano: observed,
    severityNumber: typeof line.severity_number === "number" && line.severity_number > 0
      ? line.severity_number
      : named.number,
    severityText: named.text,
    timeUnixNano: rfc3339ToNanos(line.timestamp),
    ...(traceId ? { traceId } : {}),
    ...(spanId ? { spanId } : {}),
  };
}

function resourceAttributes(line: PostHogLogLine, context: PostHogLogContext): OtlpKeyValue[] {
  const resource = objectOrEmpty(line.resource_attributes);
  return attributes(
    ...Object.entries(resource).map(([key, value]) => attribute(key, value)),
    // Logs without a service name are still told apart by project.
    resource["service.name"] ? null : attribute("service.name", "posthog"),
    attribute("cloud.provider", "posthog"),
    attribute("posthog.project.id", context.projectId),
    attribute("posthog.project.name", context.projectName),
  );
}

/** OTLP requests of at most `batch` lines each, grouped by resource and scope. */
export function postHogLogsToOtlp(
  lines: PostHogLogLine[],
  context: PostHogLogContext,
  options: { batch?: number; now?: Date } = {},
): OtlpLogsRequest[] {
  const batch = options.batch ?? 1_000;
  const observed = millisToNanos((options.now ?? new Date()).getTime());
  const requests: OtlpLogsRequest[] = [];
  for (let start = 0; start < lines.length; start += batch) {
    const groups = new Map<string, { line: PostHogLogLine; scopes: Map<string, OtlpLogRecord[]> }>();
    for (const line of lines.slice(start, start + batch)) {
      const key = line.resource_fingerprint || JSON.stringify(line.resource_attributes ?? {});
      const group = groups.get(key) ?? { line, scopes: new Map() };
      const scope = line.instrumentation_scope || "posthog.logs";
      const records = group.scopes.get(scope) ?? [];
      records.push(logRecord(line, observed));
      group.scopes.set(scope, records);
      groups.set(key, group);
    }
    requests.push({
      resourceLogs: [...groups.values()].map(({ line, scopes }) => ({
        resource: { attributes: resourceAttributes(line, context) },
        scopeLogs: [...scopes.entries()].map(([name, logRecords]) => ({ logRecords, scope: { name } })),
      })),
    });
  }
  return requests;
}
