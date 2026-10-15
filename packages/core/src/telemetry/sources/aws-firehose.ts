import { gunzipSync } from "node:zlib";
import { z } from "zod";
import {
  attribute,
  attributes,
  millisToNanos,
  objectOrEmpty,
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
export function metricStreamRequest(request: FirehoseRequest): Uint8Array<ArrayBuffer> {
  const parts: Buffer[] = [];
  for (const record of request.records) {
    const bytes = Buffer.from(record.data, "base64");
    let offset = 0;
    while (offset < bytes.length) {
      const { next, value } = readVarint(bytes, offset);
      if (next + value > bytes.length) throw new Error("Truncated message in a metric stream record");
      parts.push(bytes.subarray(next, next + value));
      offset = next + value;
    }
  }
  return Buffer.concat(parts);
}

const cloudWatchLogsSchema = z.object({
  logEvents: z.array(z.object({ id: z.string().optional(), message: z.string(), timestamp: z.number() })).default([]),
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

// The level of a structured log line, or a level word at its start.
export function logSeverity(message: string): { number: number; text: string } | undefined {
  const trimmed = message.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const fields = objectOrEmpty(JSON.parse(trimmed));
      const level = fields.level ?? fields.severity ?? fields.levelname ?? fields.log_level;
      if (typeof level === "string") return severities[level.toUpperCase()];
    } catch {
      // Not JSON after all.
    }
  }
  const word = /^(?:\S+\s+){0,3}?\[?(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\]?\b/u.exec(trimmed)?.[1];
  return word ? severities[word] : undefined;
}

// A service name for a log group: the function for Lambda, otherwise its last
// path segment.
export function logGroupService(logGroup: string): string {
  const segments = logGroup.split("/").filter(Boolean);
  return segments.at(-1) || logGroup || "aws";
}

// CloudWatch Logs subscriptions write each record as gzip-compressed JSON
// with the events of one log stream. Control messages carry no events.
// https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/SubscriptionFilters.html
export function cloudWatchLogsToOtlp(
  request: FirehoseRequest,
  source: { accountId: string; region: string } | null,
  now: number = Date.now(),
): { payload: OtlpLogsRequest; records: number; skipped: number } {
  const payload: OtlpLogsRequest = { resourceLogs: [] };
  let records = 0;
  let skipped = 0;
  for (const record of request.records) {
    let parsed: z.infer<typeof cloudWatchLogsSchema>;
    try {
      const bytes = Buffer.from(record.data, "base64");
      const text = (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString("utf8");
      parsed = cloudWatchLogsSchema.parse(JSON.parse(text));
    } catch {
      skipped += 1;
      continue;
    }
    if (parsed.messageType !== "DATA_MESSAGE" || parsed.logEvents.length === 0) continue;
    const logRecords: OtlpLogRecord[] = parsed.logEvents.map((event) => {
      const severity = logSeverity(event.message);
      records += 1;
      return {
        attributes: attributes(attribute("aws.log.event.id", event.id)),
        body: { stringValue: event.message },
        observedTimeUnixNano: millisToNanos(now),
        severityNumber: severity?.number ?? 0,
        severityText: severity?.text ?? "",
        timeUnixNano: millisToNanos(event.timestamp),
      };
    });
    payload.resourceLogs.push({
      resource: {
        attributes: attributes(
          attribute("service.name", logGroupService(parsed.logGroup)),
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
  return { payload, records, skipped };
}
