import {
  attribute,
  attributes,
  millisToNanos,
  type OtlpKeyValue,
  type OtlpLogRecord,
  type OtlpLogsRequest,
  rfc3339ToNanos,
} from "./otlp-json.js";

// Railway runtime logs as Superlog stores them. Railway keeps each line a
// service writes as its own log, marks lines written to stderr as errors, and
// reads the level of single-line JSON logs.
// https://docs.railway.com/guides/logs

export interface RailwayLogLine {
  attributes?: Array<{ key: string; value: string }> | null;
  message: string;
  severity?: string | null;
  tags?: {
    deploymentId?: string | null;
    deploymentInstanceId?: string | null;
    projectId?: string | null;
    serviceId?: string | null;
  } | null;
  timestamp: string;
}

export interface RailwayLogContext {
  environmentId: string;
  environmentName?: string;
  projectId?: string;
  projectName?: string;
  // Service names by service ID.
  services: Record<string, string>;
}

type Severity = { number: number; text: string };

const severities: Record<string, Severity> = {
  critical: { number: 21, text: "FATAL" },
  debug: { number: 5, text: "DEBUG" },
  error: { number: 17, text: "ERROR" },
  fatal: { number: 21, text: "FATAL" },
  info: { number: 9, text: "INFO" },
  notice: { number: 10, text: "INFO" },
  panic: { number: 21, text: "FATAL" },
  trace: { number: 1, text: "TRACE" },
  warn: { number: 13, text: "WARN" },
  warning: { number: 13, text: "WARN" },
};

// A plain-text line that names its own level at its start, after an optional
// timestamp, as Python's logging, uvicorn, and most loggers write it:
// `INFO:     127.0.0.1 - "GET / HTTP/1.1" 200`, `[2026-11-13 10:00:00] WARN ...`.
const leadingLevel =
  /^\s*(?:\[?\d{4}-\d{2}-\d{2}[T ][\d:.,]+(?:Z|[+-]\d{2}:?\d{2})?\]?\s*[-|]?\s*)?\[?(trace|debug|info|notice|warn|warning)\]?(?=[\s:|\]-])/iu;
// logfmt, as Go's slog and logrus write it.
const logfmtLevel = /(?:^|\s)level=["']?(trace|debug|info|notice|warn|warning)\b/iu;

/**
 * The line's severity. Railway marks everything written to stderr as an
 * error, and many loggers write every level to stderr, so an error line
 * whose text names a lower level takes that level.
 */
export function railwaySeverity(line: Pick<RailwayLogLine, "attributes" | "message" | "severity">): Severity {
  const level = (line.severity ?? line.attributes?.find((item) => item.key === "level")?.value ?? "").toLowerCase();
  const severity = severities[level];
  if (severity && severity.number < 17) return severity;
  const named = leadingLevel.exec(line.message)?.[1] ?? logfmtLevel.exec(line.message)?.[1];
  const lower = named ? severities[named.toLowerCase()] : undefined;
  if (lower && (!severity || lower.number < severity.number)) return lower;
  return severity ?? { number: 0, text: "" };
}

// A line that continues the previous line from the same replica: stack
// frames, a Python traceback's code lines, chained causes, blank lines, and
// indented JSON.
const continuation = /^(?:\s+\S|\s*$|Caused by[: ]|\.\.\. \d+ more|During handling of the above exception|The above exception was the direct cause|\[cause\]|[}\]],?$)/u;
const chainedTraceback = /^(?:During handling of the above exception|The above exception was the direct cause)/u;
const tracebackStart = "Traceback (most recent call last):";
// The line that ends a Python traceback: the exception and its message.
const tracebackEnd = /^[A-Za-z_][\w.]*(?:: .*)?$/u;
// Lines of one write arrive within microseconds of each other.
const continuationGapNanos = 1_000_000_000n;
const maxBlockLines = 200;
const maxBodyChars = 32_000;

export interface RailwayLogBlock {
  first: RailwayLogLine;
  lines: string[];
  nanos: bigint;
  severity: Severity;
}

function replica(line: RailwayLogLine): string {
  return line.tags?.deploymentInstanceId ?? line.tags?.deploymentId ?? line.tags?.serviceId ?? "";
}

type OpenBlock = { block: RailwayLogBlock; last: bigint; lastText: string; traceback: boolean };

// Whether the line joins the replica's open block, and whether it opens or
// closes a Python traceback in it.
function joins(open: OpenBlock, message: string): { joins: boolean; traceback: boolean } {
  if (message.trim() === tracebackStart && chainedTraceback.test(open.lastText)) return { joins: true, traceback: true };
  if (open.traceback && tracebackEnd.test(message)) return { joins: true, traceback: false };
  return { joins: continuation.test(message), traceback: open.traceback };
}

/**
 * Joins the lines of one multi-line write, such as a stack trace, into one
 * log, so a stack trace becomes one error rather than one per frame. Lines
 * are read in time order; each replica's lines join separately.
 */
export function railwayLogBlocks(lines: RailwayLogLine[]): RailwayLogBlock[] {
  const ordered = lines
    .map((line) => ({ line, nanos: BigInt(rfc3339ToNanos(line.timestamp)) }))
    .sort((a, b) => (a.nanos < b.nanos ? -1 : a.nanos > b.nanos ? 1 : 0));
  const blocks: RailwayLogBlock[] = [];
  const open = new Map<string, OpenBlock>();
  for (const { line, nanos } of ordered) {
    const key = replica(line);
    const current = open.get(key);
    if (current && nanos - current.last <= continuationGapNanos && current.block.lines.length < maxBlockLines) {
      const next = joins(current, line.message);
      if (next.joins) {
        current.block.lines.push(line.message);
        current.last = nanos;
        if (line.message.trim()) current.lastText = line.message;
        current.traceback = next.traceback;
        continue;
      }
    }
    const block: RailwayLogBlock = { first: line, lines: [line.message], nanos, severity: railwaySeverity(line) };
    blocks.push(block);
    open.set(key, { block, last: nanos, lastText: line.message, traceback: line.message.trim() === tracebackStart });
  }
  // A block of blank lines says nothing.
  return blocks.filter((block) => block.lines.some((text) => text.trim()));
}

// A JavaScript error and its stack, as Node prints an uncaught error.
const jsErrorLine = /^(?:Uncaught\s+)?([A-Z][\w$]*(?:Error|Exception)|Error)(?:: ([\s\S]*))?$/u;
const jsFrame = /^\s+at\s/u;

function exceptionAttributes(lines: string[], body: string): Array<OtlpKeyValue | null> {
  const match = jsErrorLine.exec(lines[0] ?? "");
  if (!match || !lines.slice(1).some((line) => jsFrame.test(line))) return [];
  return [
    attribute("exception.type", match[1]),
    attribute("exception.message", match[2] ?? ""),
    attribute("exception.stacktrace", body),
  ];
}

function truncate(text: string): string {
  return text.length > maxBodyChars ? `${text.slice(0, maxBodyChars)}…` : text;
}

const ownAttributes = new Set(["level", "message", "msg"]);
const maxStructuredAttributes = 50;

function logRecord(block: RailwayLogBlock, observedNanos: string): OtlpLogRecord {
  const body = truncate(block.lines.join("\n"));
  const structured = (block.first.attributes ?? [])
    .filter((item) => !ownAttributes.has(item.key) && !item.key.startsWith("railway.") && !item.key.startsWith("exception."))
    .slice(0, maxStructuredAttributes)
    .map((item) => attribute(item.key, item.value));
  return {
    attributes: attributes(
      attribute("railway.deployment_id", block.first.tags?.deploymentId),
      attribute("railway.deployment_instance_id", block.first.tags?.deploymentInstanceId),
      ...exceptionAttributes(block.lines, body),
      ...structured,
    ),
    body: { stringValue: body },
    observedTimeUnixNano: observedNanos,
    severityNumber: block.severity.number,
    severityText: block.severity.text,
    timeUnixNano: block.nanos.toString(),
  };
}

function resourceAttributes(serviceId: string, context: RailwayLogContext): OtlpKeyValue[] {
  return attributes(
    attribute("service.name", context.services[serviceId] ?? (serviceId || "railway")),
    attribute("telemetry.source", "railway"),
    attribute("cloud.provider", "railway"),
    attribute("railway.project_id", context.projectId),
    attribute("railway.project_name", context.projectName),
    attribute("railway.environment_id", context.environmentId),
    attribute("railway.service_id", serviceId),
    attribute("deployment.environment.name", context.environmentName),
  );
}

/**
 * OTLP log requests for the blocks, at most `batch` logs each. Logs from the
 * same service share one resource.
 */
export function railwayLogsToOtlp(
  blocks: RailwayLogBlock[],
  context: RailwayLogContext,
  options: { batch?: number; now?: Date } = {},
): OtlpLogsRequest[] {
  const batch = options.batch ?? 1_000;
  const observed = millisToNanos((options.now ?? new Date()).getTime());
  const requests: OtlpLogsRequest[] = [];
  for (let start = 0; start < blocks.length; start += batch) {
    const groups = new Map<string, OtlpLogRecord[]>();
    for (const block of blocks.slice(start, start + batch)) {
      const serviceId = block.first.tags?.serviceId ?? "";
      const records = groups.get(serviceId) ?? [];
      records.push(logRecord(block, observed));
      groups.set(serviceId, records);
    }
    requests.push({
      resourceLogs: [...groups.entries()].map(([serviceId, records]) => ({
        resource: { attributes: resourceAttributes(serviceId, context) },
        scopeLogs: [{ logRecords: records, scope: { name: "railway.environment.logs" } }],
      })),
    });
  }
  return requests;
}
