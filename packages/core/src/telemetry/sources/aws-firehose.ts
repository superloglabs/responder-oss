import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { z } from "zod";
import {
  attribute,
  attributes,
  firstString,
  millisToNanos,
  type OtlpKeyValue,
  type OtlpLogRecord,
  type OtlpLogsRequest,
} from "./otlp-json.js";

// Amazon Data Firehose delivers to an HTTP endpoint as a JSON envelope of
// base64 records, with the ingest key in X-Amz-Firehose-Access-Key, and
// expects a JSON answer that repeats the request ID.
// https://docs.aws.amazon.com/firehose/latest/dev/httpdeliveryrequestresponse.html

export const firehoseRequestSchema = z.object({
  records: z.array(z.object({ data: z.string() })).max(10_000),
  requestId: z.string().min(1).max(200),
  timestamp: z.number().optional(),
});

export type FirehoseRequest = z.infer<typeof firehoseRequestSchema>;

export function firehoseAnswer(requestId: string, errorMessage?: string, now: number = Date.now()) {
  return { requestId, timestamp: now, ...(errorMessage ? { errorMessage } : {}) };
}

// The account and region in X-Amz-Firehose-Source-Arn, when it is a delivery
// stream ARN.
export function firehoseSource(arn: string | null | undefined): { accountId: string; region: string } | null {
  const match = /^arn:aws[a-z-]*:firehose:([a-z0-9-]+):(\d{12}):deliverystream\//u.exec(arn ?? "");
  return match?.[1] && match[2] ? { accountId: match[2], region: match[1] } : null;
}

function readVarint(bytes: Uint8Array, offset: number): { next: number; value: number } {
  let value = 0;
  let shift = 0;
  let position = offset;
  while (position < bytes.length) {
    const byte = bytes[position]!;
    position += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { next: position, value };
    shift += 7;
    if (shift > 35) break;
  }
  throw new Error("Invalid length prefix in a metric stream record");
}

// A CloudWatch metric stream in the OpenTelemetry 1.0 format writes each
// record as length-prefixed ExportMetricsServiceRequest messages. Protobuf
// merges concatenated messages by appending their repeated fields, so the
// messages without their prefixes join into one request.
// https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-metric-streams-formats-opentelemetry-100.html
// More messages than a metric stream puts in one delivery. Firehose buffers 1
// to 64 MiB, and every message carries at least one metric.
const maxMetricStreamMessages = 100_000;

export function metricStreamRequest(request: FirehoseRequest): Uint8Array<ArrayBuffer> {
  const records = request.records.map((record) => Buffer.from(record.data, "base64"));
  const output = Buffer.allocUnsafe(records.reduce((total, bytes) => total + bytes.length, 0));
  let length = 0;
  let messages = 0;
  for (const bytes of records) {
    let offset = 0;
    while (offset < bytes.length) {
      const { next, value } = readVarint(bytes, offset);
      if (next + value > bytes.length) throw new Error("Truncated message in a metric stream record");
      messages += 1;
      if (messages > maxMetricStreamMessages) throw new Error("Too many messages in the metric stream records");
      length += bytes.copy(output, length, next, next + value);
      offset = next + value;
    }
  }
  return new Uint8Array(output.buffer, output.byteOffset, length) as Uint8Array<ArrayBuffer>;
}

const cloudWatchLogsSchema = z.object({
  // One PutLogEvents batch holds at most 10,000 events.
  logEvents: z.array(z.object({ id: z.string().optional(), message: z.string(), timestamp: z.number() })).max(10_000).default([]),
  logGroup: z.string().default(""),
  logStream: z.string().default(""),
  messageType: z.string(),
  owner: z.string().default(""),
  subscriptionFilters: z.array(z.string()).default([]),
});

const severities: Record<string, { number: number; text: string }> = {
  CRITICAL: { number: 21, text: "FATAL" },
  DEBUG: { number: 5, text: "DEBUG" },
  ERROR: { number: 17, text: "ERROR" },
  FATAL: { number: 21, text: "FATAL" },
  INFO: { number: 9, text: "INFO" },
  TRACE: { number: 1, text: "TRACE" },
  WARN: { number: 13, text: "WARN" },
  WARNING: { number: 13, text: "WARN" },
};

// Pino and Bunyan write the level as a number.
const numericLevels: Record<number, string> = { 10: "TRACE", 20: "DEBUG", 30: "INFO", 40: "WARN", 50: "ERROR", 60: "FATAL" };

// The fields of a log line that is one JSON object.
function jsonFields(message: string): Record<string, unknown> | undefined {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// The level of a structured log line, or a level word at its start.
export function logSeverity(message: string): { number: number; text: string } | undefined {
  return severityOf(message, jsonFields(message));
}

function severityOf(message: string, fields: Record<string, unknown> | undefined) {
  if (fields) {
    const level = fields.level ?? fields.severity ?? fields.levelname ?? fields.log_level;
    if (typeof level === "number") return severities[numericLevels[level] ?? ""];
    return typeof level === "string" ? severities[level.toUpperCase()] : undefined;
  }
  const word = /^(?:\S+\s+){0,3}?\[?(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\]?\b/u.exec(message.trimStart())?.[1];
  return word ? severities[word] : undefined;
}

// A JSON log line keeps its message as the body and its fields as
// attributes, as the console logs sent over OTLP do. Other lines stay as
// written.
export function logLine(message: string): { attributes: OtlpKeyValue[]; body: string; severity?: { number: number; text: string } } {
  const fields = jsonFields(message);
  if (!fields) return { attributes: [], body: message, severity: severityOf(message, fields) };
  return {
    attributes: attributes(...Object.entries(fields).map(([key, value]) => attribute(key, value))),
    body: firstString(fields.msg, fields.message, fields.event) || message,
    severity: severityOf(message, fields),
  };
}

// CloudFormation names a resource {stack}-{logical ID}-{random}, and CDK ends
// the logical ID with an eight-digit hash. The stack and the construct are the
// readable part.
function withoutGeneratedSuffix(name: string): string {
  return /^(.+-.+?)[0-9A-F]{8}-[A-Za-z0-9]{12}$/u.exec(name)?.[1] ?? name;
}

// A service name for a log stream: the container of an ECS task
// (prefix/container/task-id), the database for RDS, the cluster for Container
// Insights, the function for Lambda, otherwise the group's last path segment.
export function logGroupService(logGroup: string, logStream = ""): string {
  const container = /^[^/]+\/([^/]+)\/[0-9a-f]{32}$/u.exec(logStream)?.[1];
  if (container) return container;
  const named = /^\/aws\/(?:rds\/(?:instance|cluster)|ecs\/containerinsights)\/([^/]+)\//u.exec(logGroup)?.[1];
  const segments = logGroup.split("/").filter(Boolean);
  return withoutGeneratedSuffix(named || segments.at(-1) || logGroup) || "aws";
}

export type CloudWatchLogsMessage = z.infer<typeof cloudWatchLogsSchema>;

const gunzipAsync = promisify(gunzip);

// A CloudWatch Logs subscription record holds one PutLogEvents batch, which is
// at most 1 MiB of events. Records are inflated off the event loop and only up
// to these sizes, so a small, highly compressed record cannot take the
// process's memory.
export const cloudWatchLogsRecordLimits = {
  maxRecordBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
};

// CloudWatch Logs subscriptions write each record as gzip-compressed JSON
// with the events of one log stream. Control messages carry no events and are
// left out, with records that cannot be read, or that are larger than the
// limits, counted as skipped.
// https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/SubscriptionFilters.html
export async function decodeCloudWatchLogsRecords(
  request: FirehoseRequest,
  limits: { maxRecordBytes: number; maxTotalBytes: number } = cloudWatchLogsRecordLimits,
): Promise<{ messages: CloudWatchLogsMessage[]; skipped: number }> {
  const messages: CloudWatchLogsMessage[] = [];
  let remaining = limits.maxTotalBytes;
  let skipped = 0;
  for (const record of request.records) {
    let parsed: CloudWatchLogsMessage;
    try {
      const limit = Math.min(limits.maxRecordBytes, remaining);
      if (limit <= 0) throw new Error("The request's records are too large");
      // The record's limit is taken from the budget before it is read, and
      // only the unused part comes back, so records that fail still use it.
      remaining -= limit;
      const bytes = Buffer.from(record.data, "base64");
      const text = bytes[0] === 0x1f && bytes[1] === 0x8b
        ? await gunzipAsync(bytes, { maxOutputLength: limit })
        : bytes;
      if (text.length > limit) throw new Error("The record is too large");
      remaining += limit - text.length;
      parsed = cloudWatchLogsSchema.parse(JSON.parse(text.toString("utf8")));
    } catch {
      skipped += 1;
      continue;
    }
    if (parsed.messageType !== "DATA_MESSAGE" || parsed.logEvents.length === 0) continue;
    messages.push(parsed);
  }
  return { messages, skipped };
}

// OTLP logs for decoded messages. The account is each message's owner, or
// the source's; the region is the source's.
export function cloudWatchLogsMessagesToOtlp(
  messages: CloudWatchLogsMessage[],
  source: { accountId: string; region: string } | null,
  now: number = Date.now(),
): { payload: OtlpLogsRequest; records: number } {
  const payload: OtlpLogsRequest = { resourceLogs: [] };
  let records = 0;
  for (const parsed of messages) {
    const logRecords: OtlpLogRecord[] = parsed.logEvents.map((event) => {
      const line = logLine(event.message);
      records += 1;
      return {
        attributes: [...attributes(attribute("aws.log.event.id", event.id)), ...line.attributes],
        body: { stringValue: line.body },
        observedTimeUnixNano: millisToNanos(now),
        severityNumber: line.severity?.number ?? 0,
        severityText: line.severity?.text ?? "",
        timeUnixNano: millisToNanos(event.timestamp),
      };
    });
    payload.resourceLogs.push({
      resource: {
        attributes: attributes(
          attribute("service.name", logGroupService(parsed.logGroup, parsed.logStream)),
          attribute("telemetry.source", "aws"),
          attribute("cloud.provider", "aws"),
          attribute("cloud.account.id", parsed.owner || source?.accountId),
          attribute("cloud.region", source?.region),
          attribute("aws.log.group.names", parsed.logGroup),
          attribute("aws.log.stream.names", parsed.logStream),
        ),
      },
      scopeLogs: [{ logRecords, scope: { name: "aws.cloudwatch_logs" } }],
    });
  }
  return { payload, records };
}

export async function cloudWatchLogsToOtlp(
  request: FirehoseRequest,
  source: { accountId: string; region: string } | null,
  now: number = Date.now(),
): Promise<{ payload: OtlpLogsRequest; records: number; skipped: number }> {
  const { messages, skipped } = await decodeCloudWatchLogsRecords(request);
  return { ...cloudWatchLogsMessagesToOtlp(messages, source, now), skipped };
}
