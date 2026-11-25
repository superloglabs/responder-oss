import type { RenderLogLine } from "../../integrations/render.js";
import {
  attribute,
  attributes,
  millisToNanos,
  type OtlpKeyValue,
  type OtlpLogRecord,
  type OtlpLogsRequest,
} from "./otlp-json.js";
import { exceptionAttributes, type RailwayLogLine, railwayLogBlocks } from "./railway-logs.js";

// Render logs as Superlog stores them. Like Railway, Render keeps each line a
// service writes as its own log, so the lines of one write, such as a stack
// trace, are joined the way Railway's are, per instance. Build logs are
// left out. Request logs keep their method, path, and status under the
// names OpenTelemetry uses, so a request that failed with a server error
// becomes an error issue.

export interface RenderServiceInfo {
  name: string;
  region?: string | null;
  type?: string;
}

export interface RenderLogContext {
  ownerId: string;
  // Services by ID. A service not listed is named by its ID.
  services: Record<string, RenderServiceInfo>;
  workspaceName?: string;
}

const maxBodyChars = 32_000;
const maxExtraLabels = 30;

// eslint-disable-next-line no-control-regex -- ANSI escapes start with ESC.
const ansiEscape = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;

export function stripAnsi(value: string): string {
  return value.replace(ansiEscape, "");
}

export function renderLabel(line: Pick<RenderLogLine, "labels">, name: string): string | undefined {
  return line.labels.find((label) => label.name === name)?.value;
}

export function isRenderBuildLog(line: Pick<RenderLogLine, "labels">): boolean {
  return renderLabel(line, "type") === "build";
}

// Labels that become a resource or a named attribute.
const namedLabels = new Set(["resource", "instance", "level", "type", "method", "path", "statusCode", "host", "requestID"]);

function requestStatus(line: RenderLogLine): number | undefined {
  const value = renderLabel(line, "statusCode");
  if (!value || !/^\d{3}$/u.test(value)) return undefined;
  return Number(value);
}

function lineAttributes(line: RenderLogLine): Array<OtlpKeyValue | null> {
  const extra = line.labels
    .filter((label) => !namedLabels.has(label.name))
    .slice(0, maxExtraLabels)
    .map((label) => attribute(`render.${label.name}`, label.value));
  return [
    attribute("render.instance_id", renderLabel(line, "instance")),
    attribute("render.log_type", renderLabel(line, "type")),
    attribute("render.log_id", line.id),
    attribute("http.request.method", renderLabel(line, "method")),
    attribute("url.path", renderLabel(line, "path")),
    attribute("http.response.status_code", requestStatus(line)),
    attribute("server.address", renderLabel(line, "host")),
    attribute("render.request_id", renderLabel(line, "requestID")),
    ...extra,
  ];
}

export interface RenderLogBlock {
  first: RenderLogLine;
  lines: string[];
  nanos: bigint;
  severity: { number: number; text: string };
}

/**
 * Joins the lines of one multi-line write into one log. Lines of each
 * instance and log type join separately, so a request log never joins an
 * application's stack trace.
 */
export function renderLogBlocks(lines: RenderLogLine[]): RenderLogBlock[] {
  const origins = new Map<RailwayLogLine, RenderLogLine>();
  const mapped = lines.filter((line) => !isRenderBuildLog(line)).map((line) => {
    const resource = renderLabel(line, "resource") ?? "";
    const instance = renderLabel(line, "instance") ?? resource;
    const shaped: RailwayLogLine = {
      message: stripAnsi(line.message),
      severity: renderLabel(line, "level") ?? null,
      tags: { deploymentInstanceId: `${instance}\u0000${renderLabel(line, "type") ?? ""}`, serviceId: resource },
      timestamp: line.timestamp,
    };
    origins.set(shaped, line);
    return shaped;
  });
  return railwayLogBlocks(mapped).map((block) => ({
    first: origins.get(block.first)!,
    lines: block.lines,
    nanos: block.nanos,
    severity: block.severity,
  }));
}

function truncate(value: string): string {
  return value.length > maxBodyChars ? `${value.slice(0, maxBodyChars)}…` : value;
}

function logRecord(block: RenderLogBlock, observedNanos: string): OtlpLogRecord {
  const body = truncate(block.lines.join("\n"));
  return {
    attributes: attributes(...lineAttributes(block.first), ...exceptionAttributes(block.lines, body)),
    body: { stringValue: body },
    observedTimeUnixNano: observedNanos,
    severityNumber: block.severity.number,
    severityText: block.severity.text,
    timeUnixNano: block.nanos.toString(),
  };
}

function resourceAttributes(serviceId: string, context: RenderLogContext): OtlpKeyValue[] {
  const service = context.services[serviceId];
  return attributes(
    attribute("service.name", service?.name ?? (serviceId || "render")),
    attribute("telemetry.source", "render"),
    attribute("cloud.provider", "render"),
    attribute("cloud.region", service?.region),
    attribute("render.owner_id", context.ownerId),
    attribute("render.workspace_name", context.workspaceName),
    attribute("render.service_id", serviceId),
    attribute("render.service_type", service?.type),
  );
}

/**
 * OTLP log requests for the blocks, at most `batch` logs each. Logs from the
 * same service share one resource.
 */
export function renderLogsToOtlp(
  blocks: RenderLogBlock[],
  context: RenderLogContext,
  options: { batch?: number; now?: Date } = {},
): OtlpLogsRequest[] {
  const batch = options.batch ?? 1_000;
  const observed = millisToNanos((options.now ?? new Date()).getTime());
  const requests: OtlpLogsRequest[] = [];
  for (let start = 0; start < blocks.length; start += batch) {
    const groups = new Map<string, OtlpLogRecord[]>();
    for (const block of blocks.slice(start, start + batch)) {
      const serviceId = renderLabel(block.first, "resource") ?? "";
      const records = groups.get(serviceId) ?? [];
      records.push(logRecord(block, observed));
      groups.set(serviceId, records);
    }
    requests.push({
      resourceLogs: [...groups.entries()].map(([serviceId, records]) => ({
        resource: { attributes: resourceAttributes(serviceId, context) },
        scopeLogs: [{ logRecords: records, scope: { name: "render.logs" } }],
      })),
    });
  }
  return requests;
}
