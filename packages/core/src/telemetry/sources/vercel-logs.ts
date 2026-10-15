import {
  attribute,
  attributes,
  hexId,
  jsonText,
  millisToNanos,
  objectOrEmpty,
  type OtlpKeyValue,
  type OtlpLogRecord,
  type OtlpLogsRequest,
  stringOrEmpty,
} from "./otlp-json.js";

// Vercel log drains deliver JSON: an array of records, one record, or NDJSON.
// https://vercel.com/docs/drains/reference/logs

export type VercelLogRecord = Record<string, unknown>;

const severities: Record<string, { number: number; text: string }> = {
  debug: { number: 5, text: "DEBUG" },
  error: { number: 17, text: "ERROR" },
  fatal: { number: 21, text: "FATAL" },
  info: { number: 9, text: "INFO" },
  warn: { number: 13, text: "WARN" },
  warning: { number: 13, text: "WARN" },
};

export function parseVercelLogs(body: string, contentType: string): VercelLogRecord[] {
  const text = body.trim();
  if (!text) return [];
  const records = contentType.toLowerCase().includes("ndjson")
    ? text.split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown)
    : ([JSON.parse(text)] as unknown[]).flat();
  return records.map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid Vercel log record");
    return record as VercelLogRecord;
  });
}

function resourceAttributes(log: VercelLogRecord): OtlpKeyValue[] {
  return attributes(
    attribute("service.name", stringOrEmpty(log.projectName) || stringOrEmpty(log.host) || "vercel"),
    attribute("telemetry.source", "vercel"),
    attribute("cloud.provider", "vercel"),
    attribute("vercel.project_id", log.projectId),
    attribute("vercel.project_name", log.projectName),
    attribute("vercel.host", log.host),
    attribute("deployment.environment.name", log.environment),
  );
}

function logRecord(log: VercelLogRecord): OtlpLogRecord {
  const severity = typeof log.level === "string" ? severities[log.level.toLowerCase()] : undefined;
  const proxy = objectOrEmpty(log.proxy);
  const traceId = hexId(log.traceId ?? log["trace.id"], 32);
  const spanId = hexId(log.spanId ?? log["span.id"], 16);
  return {
    attributes: attributes(
      attribute("vercel.id", log.id),
      attribute("vercel.deployment_id", log.deploymentId),
      attribute("vercel.source", log.source),
      attribute("vercel.build_id", log.buildId),
      attribute("vercel.type", log.type),
      attribute("vercel.entrypoint", log.entrypoint),
      attribute("vercel.request_id", log.requestId),
      attribute("vercel.branch", log.branch),
      attribute("vercel.execution_region", log.executionRegion),
      attribute("url.path", log.path),
      attribute("http.response.status_code", log.statusCode),
      attribute("http.request.method", proxy.method),
      attribute("server.address", proxy.host),
      attribute("client.address", proxy.clientIp),
      attribute("user_agent.original", Array.isArray(proxy.userAgent) ? proxy.userAgent.join(", ") : proxy.userAgent),
      attribute("vercel.proxy.path", proxy.path),
      attribute("vercel.proxy.region", proxy.region),
      attribute("vercel.proxy.status_code", proxy.statusCode),
      attribute("vercel.proxy.cache", proxy.vercelCache),
      attribute("vercel.proxy.path_type", proxy.pathType),
    ),
    body: { stringValue: typeof log.message === "string" ? log.message : jsonText(log.message ?? log) },
    observedTimeUnixNano: millisToNanos(Date.now()),
    severityNumber: severity?.number ?? 0,
    severityText: severity?.text ?? "",
    timeUnixNano: millisToNanos(log.timestamp),
    ...(traceId ? { traceId } : {}),
    ...(spanId ? { spanId } : {}),
  };
}

// Records from the same project and host share one resource.
export function vercelLogsToOtlp(logs: VercelLogRecord[]): OtlpLogsRequest {
  const groups = new Map<string, { records: OtlpLogRecord[]; resource: OtlpKeyValue[] }>();
  for (const log of logs) {
    const resource = resourceAttributes(log);
    const key = jsonText(resource);
    const group = groups.get(key) ?? { records: [], resource };
    group.records.push(logRecord(log));
    groups.set(key, group);
  }
  return {
    resourceLogs: [...groups.values()].map((group) => ({
      resource: { attributes: group.resource },
      scopeLogs: [{ logRecords: group.records, scope: { name: "vercel.drains.logs" } }],
    })),
  };
}
