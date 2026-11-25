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
// Postgres writes every line to stderr after its log_line_prefix, by default
// a timestamp with its zone and the process ID, sometimes followed by
// user@database: `2026-11-19 13:01:27.463 UTC [130] LOG:  checkpoint
// starting: time`.
const postgresPrefix = String.raw`^\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)? [A-Za-z0-9+:-]+ \[\d+\](?: \S+)?\s+`;
const postgresLevel = new RegExp(`${postgresPrefix}(DEBUG[1-5]?|LOG|INFO|NOTICE|WARNING|ERROR|FATAL|PANIC):`, "u");
// The Postgres backend process that wrote the line. Processes share a
// replica and their lines can interleave.
const postgresProcess = new RegExp(String.raw`^\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)? [A-Za-z0-9+:-]+ \[(\d+)\]`, "u");
// The lines Postgres writes after an error about the same statement.
const postgresDetail = new RegExp(`${postgresPrefix}(?:DETAIL|HINT|CONTEXT|STATEMENT|QUERY|LOCATION):`, "u");
const postgresLevels: Record<string, string> = {
  DEBUG: "debug",
  ERROR: "error",
  FATAL: "fatal",
  INFO: "info",
  LOG: "info",
  NOTICE: "notice",
  PANIC: "panic",
  WARNING: "warning",
};

function postgresSeverityName(message: string): string | undefined {
  const level = postgresLevel.exec(message)?.[1];
  return level ? postgresLevels[level.replace(/\d$/u, "")] : undefined;
}

/**
 * Whether the line comes from Railway's builder rather than a service.
 * Railway writes its build machinery's logs, such as BuildKit's, into the
 * environment's logs with the build's ID as both service and deployment.
 */
export function isRailwayBuildLog(line: Pick<RailwayLogLine, "tags">): boolean {
  const serviceId = line.tags?.serviceId;
  return Boolean(serviceId) && serviceId === line.tags?.deploymentId;
}

/**
 * The line's severity. Railway marks everything written to stderr as an
 * error, and many loggers write every level to stderr, so an error line
 * whose text names a lower level takes that level.
 */
export function railwaySeverity(line: Pick<RailwayLogLine, "attributes" | "message" | "severity">): Severity {
  const level = (line.severity ?? line.attributes?.find((item) => item.key === "level")?.value ?? "").toLowerCase();
  const severity = severities[level];
  if (severity && severity.number < 17) return severity;
  const named = leadingLevel.exec(line.message)?.[1] ?? logfmtLevel.exec(line.message)?.[1] ?? postgresSeverityName(line.message);
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
  if (postgresDetail.test(message)) return { joins: true, traceback: open.traceback };
  return { joins: continuation.test(message), traceback: open.traceback };
}

/**
 * Joins the lines of one multi-line write, such as a stack trace, into one
 * log, so a stack trace becomes one error rather than one per frame. Lines
 * are read in time order; each replica's lines join separately.
 */
export function railwayLogBlocks(lines: RailwayLogLine[]): RailwayLogBlock[] {
  const ordered = lines
    .filter((line) => !isRailwayBuildLog(line))
    .map((line) => ({ line, nanos: BigInt(rfc3339ToNanos(line.timestamp)) }))
    .sort((a, b) => (a.nanos < b.nanos ? -1 : a.nanos > b.nanos ? 1 : 0));
  const blocks: RailwayLogBlock[] = [];
  // Open blocks by replica, and by Postgres process within a replica. A line
  // without a process joins the replica's latest block, such as the next
  // line of a multi-line statement.
  const open = new Map<string, OpenBlock>();
  const latest = new Map<string, string>();
  for (const { line, nanos } of ordered) {
    const replicaKey = replica(line);
    const process = postgresProcess.exec(line.message)?.[1];
    const processKey = process ? `${replicaKey}\u0000${process}` : null;
    const key = processKey ?? latest.get(replicaKey) ?? replicaKey;
    const current = open.get(key);
    if (current && nanos - current.last <= continuationGapNanos && current.block.lines.length < maxBlockLines) {
      const next = joins(current, line.message);
      if (next.joins) {
        current.block.lines.push(line.message);
        current.last = nanos;
        if (line.message.trim()) current.lastText = line.message;
        current.traceback = next.traceback;
        latest.set(replicaKey, key);
        continue;
      }
    }
    const block: RailwayLogBlock = { first: line, lines: [line.message], nanos, severity: railwaySeverity(line) };
    blocks.push(block);
    const blockKey = processKey ?? replicaKey;
    open.set(blockKey, { block, last: nanos, lastText: line.message, traceback: line.message.trim() === tracebackStart });
    latest.set(replicaKey, blockKey);
  }
  // A block of blank lines says nothing.
  return blocks.filter((block) => block.lines.some((text) => text.trim()));
}

// A JavaScript error and its stack, as Node prints an uncaught error.
const jsErrorLine = /^(?:Uncaught\s+)?([A-Z][\w$]*(?:Error|Exception)|Error)(?:: ([\s\S]*))?$/u;
const jsFrame = /^\s+at\s/u;

export function exceptionAttributes(lines: string[], body: string): Array<OtlpKeyValue | null> {
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
