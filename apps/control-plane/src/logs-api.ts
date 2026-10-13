import { apiErrorMessage } from "./agents-api";
import type { TelemetryRange } from "../server/telemetry/routes";

export type { TelemetryRange };

export interface TelemetryProject {
  name: string;
  projectId: string;
}

export interface LogRecord {
  body: string;
  exception_message: string;
  exception_stacktrace: string;
  exception_type: string;
  log_attrs: Record<string, string>;
  resource_attrs: Record<string, string>;
  service: string;
  severity: string;
  severity_number: number;
  span_id: string;
  timestamp: string;
  trace_id: string;
}

export interface LogQuery {
  projectId: string;
  range: TelemetryRange;
  search: string;
  service: string;
  severity: string;
}

async function telemetryJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body as T;
}

// Null when the workspace cannot read telemetry.
export async function fetchTelemetryProjects(): Promise<TelemetryProject[] | null> {
  const response = await fetch("/api/telemetry/projects");
  if (response.status === 404) return null;
  const body = (await response.json().catch(() => null)) as { projects: TelemetryProject[] } | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body?.projects ?? [];
}

export function logSearchParams(query: LogQuery): URLSearchParams {
  const params = new URLSearchParams({ projectId: query.projectId, range: query.range });
  if (query.search.trim()) params.set("search", query.search.trim());
  if (query.service) params.set("service", query.service);
  if (query.severity) params.set("severity", query.severity);
  return params;
}

export async function fetchLogs(query: LogQuery): Promise<LogRecord[]> {
  const body = await telemetryJson<{ logs: LogRecord[] }>(
    `/api/telemetry/logs?${logSearchParams(query)}`,
  );
  return body.logs;
}

export async function fetchServices(projectId: string, range: TelemetryRange): Promise<string[]> {
  const params = new URLSearchParams({ projectId, range });
  const body = await telemetryJson<{ services: string[] }>(`/api/telemetry/services?${params}`);
  return body.services;
}

// ClickHouse returns UTC timestamps such as "2026-10-13 15:04:05.123456789".
export function logTimestamp(value: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,3})?/.exec(value);
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}${match[3] ?? ""}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export type SeverityTone = "danger" | "info" | "neutral" | "warning";

// OpenTelemetry severity numbers: 1-8 trace and debug, 9-12 info, 13-16 warn,
// 17-24 error and fatal.
export function severityTone(severityNumber: number): SeverityTone {
  if (severityNumber >= 17) return "danger";
  if (severityNumber >= 13) return "warning";
  if (severityNumber >= 9) return "info";
  return "neutral";
}
