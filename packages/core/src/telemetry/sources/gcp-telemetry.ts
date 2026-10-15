import {
  attribute,
  attributes,
  firstString,
  hexId,
  jsonText,
  objectOrEmpty,
  type OtlpKeyValue,
  type OtlpLogRecord,
  type OtlpLogsRequest,
  prefixedAttributes,
  rfc3339ToNanos,
  stringOrEmpty,
} from "./otlp-json.js";

// Converts Cloud Logging entries and Cloud Monitoring time series to OTLP.
// https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry
// https://cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.timeSeries

const severityNumbers: Record<string, number> = {
  ALERT: 21,
  CRITICAL: 18,
  DEBUG: 5,
  DEFAULT: 0,
  EMERGENCY: 22,
  ERROR: 17,
  INFO: 9,
  NOTICE: 10,
  WARNING: 13,
};

function resourceAttributes(
  gcpProjectId: string,
  resource: { labels?: Record<string, unknown>; type?: unknown },
  serviceName: string,
): OtlpKeyValue[] {
  return attributes(
    attribute("service.name", serviceName),
    attribute("telemetry.source", "gcp"),
    attribute("cloud.provider", "gcp"),
    attribute("cloud.account.id", gcpProjectId),
    attribute("gcp.project.id", gcpProjectId),
    attribute("gcp.resource.type", resource.type),
    ...prefixedAttributes("gcp.resource.label", resource.labels),
  );
}

function logServiceName(resource: Record<string, unknown>): string {
  const labels = objectOrEmpty(resource.labels);
  return (
    firstString(labels.service_name, labels.container_name, labels.function_name, labels.job_name, labels.cluster_name, labels.instance_id) ||
    stringOrEmpty(resource.type) ||
    "gcp"
  );
}

function logBody(entry: Record<string, unknown>): string {
  if (typeof entry.textPayload === "string") return entry.textPayload;
  const json = objectOrEmpty(entry.jsonPayload);
  if (typeof json.message === "string" && Object.keys(json).length === 1) return json.message;
  if (entry.jsonPayload !== undefined) return jsonText(entry.jsonPayload);
  if (entry.protoPayload !== undefined) return jsonText(entry.protoPayload);
  return jsonText(entry);
}

// Entries from the same resource share one OTLP resource.
export function gcpLogEntriesToOtlp(entries: unknown[], gcpProjectId: string): OtlpLogsRequest {
  const groups = new Map<string, { records: OtlpLogRecord[]; resource: OtlpKeyValue[] }>();
  for (const value of entries) {
    const entry = objectOrEmpty(value);
    const resource = objectOrEmpty(entry.resource);
    const resourceKey = jsonText(resource);
    const group = groups.get(resourceKey) ?? {
      records: [],
      resource: resourceAttributes(gcpProjectId, { labels: objectOrEmpty(resource.labels), type: resource.type }, logServiceName(resource)),
    };
    const severityText = stringOrEmpty(entry.severity).toUpperCase();
    const traceId = hexId(stringOrEmpty(entry.trace).split("/").at(-1), 32);
    const spanId = hexId(entry.spanId, 16);
    const http = objectOrEmpty(entry.httpRequest);
    group.records.push({
      attributes: attributes(
        attribute("gcp.insert_id", entry.insertId),
        attribute("gcp.log_name", entry.logName),
        attribute("http.request.method", http.requestMethod),
        attribute("url.full", http.requestUrl),
        attribute("http.response.status_code", http.status),
        attribute("user_agent.original", http.userAgent),
        attribute("client.address", http.remoteIp),
        attribute("gcp.http_request.latency", http.latency),
        ...prefixedAttributes("gcp.label", entry.labels),
      ),
      body: { stringValue: logBody(entry) },
      flags: entry.traceSampled === true ? 1 : 0,
      observedTimeUnixNano: rfc3339ToNanos(entry.receiveTimestamp),
      severityNumber: severityNumbers[severityText] ?? 0,
      severityText: severityText === "DEFAULT" ? "" : severityText,
      timeUnixNano: rfc3339ToNanos(entry.timestamp),
      ...(traceId ? { traceId } : {}),
      ...(spanId ? { spanId } : {}),
    });
    groups.set(resourceKey, group);
  }
  return {
    resourceLogs: [...groups.values()].map((group) => ({
      resource: { attributes: group.resource },
      scopeLogs: [{ logRecords: group.records, scope: { name: "gcp.cloud_logging" } }],
    })),
  };
}

// Metrics read every pull: compute, Cloud Run, Cloud SQL, load balancing and
// Pub/Sub. Each type is one Monitoring request per page.
export const gcpMetricTypes = [
  "compute.googleapis.com/instance/cpu/utilization",
  "run.googleapis.com/container/cpu/utilizations",
  "run.googleapis.com/container/memory/utilizations",
  "run.googleapis.com/request_count",
  "run.googleapis.com/request_latencies",
  "cloudsql.googleapis.com/database/cpu/utilization",
  "loadbalancing.googleapis.com/https/request_count",
  "pubsub.googleapis.com/subscription/num_undelivered_messages",
] as const;

type GcpDistribution = {
  bucketCounts?: string[];
  bucketOptions?: {
    explicitBuckets?: { bounds?: number[] };
    exponentialBuckets?: { growthFactor?: number; numFiniteBuckets?: number; scale?: number };
    linearBuckets?: { numFiniteBuckets?: number; offset?: number; width?: number };
  };
  count?: string;
  mean?: number;
  range?: { max?: number; min?: number };
};

export type GcpTimeSeries = {
  metric?: { labels?: Record<string, string>; type?: string };
  metricKind?: string;
  points?: Array<{
    interval?: { endTime?: string; startTime?: string };
    value?: { boolValue?: boolean; distributionValue?: GcpDistribution; doubleValue?: number; int64Value?: string };
  }>;
  resource?: { labels?: Record<string, string>; type?: string };
  unit?: string;
  valueType?: string;
};

function bucketBounds(options: NonNullable<GcpDistribution["bucketOptions"]>): number[] | null {
  if (options.explicitBuckets?.bounds) return options.explicitBuckets.bounds;
  const linear = options.linearBuckets;
  if (linear?.numFiniteBuckets && typeof linear.width === "number" && typeof linear.offset === "number") {
    return Array.from({ length: linear.numFiniteBuckets + 1 }, (_, index) => linear.offset! + linear.width! * index);
  }
  const exponential = options.exponentialBuckets;
  if (exponential?.numFiniteBuckets && typeof exponential.growthFactor === "number" && typeof exponential.scale === "number") {
    return Array.from({ length: exponential.numFiniteBuckets + 1 }, (_, index) => exponential.scale! * exponential.growthFactor! ** index);
  }
  return null;
}

// Google counts an underflow bucket before the bounds and an overflow bucket
// after them, as OTLP does, and may leave trailing empty buckets out.
function histogramPoint(value: GcpDistribution | undefined) {
  if (!value?.count || !value.bucketOptions) return null;
  const explicitBounds = bucketBounds(value.bucketOptions);
  if (!explicitBounds) return null;
  const bucketCounts = [...(value.bucketCounts ?? [])];
  while (bucketCounts.length < explicitBounds.length + 1) bucketCounts.push("0");
  if (bucketCounts.length !== explicitBounds.length + 1) return null;
  const count = Number(value.count);
  return {
    bucketCounts,
    count: value.count,
    explicitBounds,
    ...(typeof value.mean === "number" && Number.isFinite(count) ? { sum: value.mean * count } : {}),
    ...(typeof value.range?.min === "number" ? { min: value.range.min } : {}),
    ...(typeof value.range?.max === "number" ? { max: value.range.max } : {}),
  };
}

function numberPoint(value: NonNullable<GcpTimeSeries["points"]>[number]["value"]) {
  if (typeof value?.doubleValue === "number") return { asDouble: value.doubleValue };
  if (typeof value?.int64Value === "string") return { asInt: value.int64Value };
  if (typeof value?.boolValue === "boolean") return { asInt: value.boolValue ? "1" : "0" };
  return null;
}

function metricServiceName(series: GcpTimeSeries): string {
  const labels = series.resource?.labels ?? {};
  return labels.service_name ?? labels.container_name ?? labels.database_id ?? labels.instance_id ?? series.resource?.type ?? "gcp";
}

export function gcpTimeSeriesToOtlp(series: GcpTimeSeries[], gcpProjectId: string) {
  return {
    resourceMetrics: series.map((timeSeries) => {
      const pointAttributes = Object.entries(timeSeries.metric?.labels ?? {}).map(([key, value]) => ({
        key: `gcp.metric.label.${key}`,
        value: { stringValue: value },
      }));
      const distribution = timeSeries.valueType === "DISTRIBUTION";
      const dataPoints = (timeSeries.points ?? []).flatMap((point) => {
        if (!point.interval?.endTime) return [];
        const value = distribution ? histogramPoint(point.value?.distributionValue) : numberPoint(point.value);
        if (!value) return [];
        return [{
          ...value,
          attributes: pointAttributes,
          timeUnixNano: rfc3339ToNanos(point.interval.endTime),
          ...(point.interval.startTime ? { startTimeUnixNano: rfc3339ToNanos(point.interval.startTime) } : {}),
        }];
      });
      const temporality = timeSeries.metricKind === "DELTA" ? 1 : 2;
      const data = distribution
        ? { histogram: { aggregationTemporality: temporality, dataPoints } }
        : timeSeries.metricKind === "GAUGE"
          ? { gauge: { dataPoints } }
          : { sum: { aggregationTemporality: temporality, dataPoints, isMonotonic: timeSeries.metricKind === "CUMULATIVE" } };
      return {
        resource: {
          attributes: resourceAttributes(gcpProjectId, timeSeries.resource ?? {}, metricServiceName(timeSeries)),
        },
        scopeMetrics: [{
          metrics: [{ name: timeSeries.metric?.type ?? "gcp.unknown", ...(timeSeries.unit ? { unit: timeSeries.unit } : {}), ...data }],
          scope: { name: "gcp.cloud_monitoring" },
        }],
      };
    }),
  };
}
