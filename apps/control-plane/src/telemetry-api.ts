import { apiErrorMessage } from "./agents-api";
import type { TelemetryRange, TelemetrySignal } from "../server/telemetry/routes";

export type { TelemetryRange, TelemetrySignal };

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

// A trace that started in the window. ClickHouse returns its counts as strings.
export interface TraceSummary {
  duration_ms: number;
  error_count: number | string;
  root_service: string;
  root_span_name: string;
  root_status_code: string;
  service_count: number | string;
  span_count: number | string;
  start_time: string;
  trace_id: string;
}

export interface TraceQuery {
  minDurationMs: number;
  projectId: string;
  range: TelemetryRange;
  service: string;
  status: "" | "error";
}

export interface Span {
  duration_ms: number;
  exception_message: string;
  exception_stacktrace: string;
  exception_type: string;
  parent_span_id: string;
  resource_attrs: Record<string, string>;
  service: string;
  span_attrs: Record<string, string>;
  span_id: string;
  span_kind: string;
  span_name: string;
  start_ns: string;
  status_code: string;
  status_message: string;
  timestamp: string;
  trace_id: string;
}

export interface TraceDetail {
  logs: Array<Omit<LogRecord, "severity_number"> & { ts_ns: string }>;
  spans: Span[];
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

export async function fetchServices(
  projectId: string,
  range: TelemetryRange,
  signal: TelemetrySignal = "logs",
): Promise<string[]> {
  const params = new URLSearchParams({ projectId, range, signal });
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

export const telemetryRanges: Array<{ label: string; value: TelemetryRange }> = [
  { label: "15m", value: "15m" },
  { label: "1h", value: "1h" },
  { label: "6h", value: "6h" },
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
];

export function formatTelemetryTime(value: string): string {
  const date = logTimestamp(value);
  if (!date) return value;
  return date.toLocaleString(undefined, {
    day: "numeric",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    second: "2-digit",
  });
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

// Severity text as sent, for records without a severity number.
export function severityTextTone(severity: string): SeverityTone {
  const text = severity.toUpperCase();
  if (text.startsWith("ERR") || text.startsWith("FATAL") || text.startsWith("CRIT")) return "danger";
  if (text.startsWith("WARN")) return "warning";
  if (text.startsWith("INFO")) return "info";
  return "neutral";
}

export function spanStatus(statusCode: string): { label: string; tone: SeverityTone } {
  if (statusCode === "STATUS_CODE_ERROR") return { label: "Error", tone: "danger" };
  if (statusCode === "STATUS_CODE_OK") return { label: "OK", tone: "neutral" };
  return { label: "Unset", tone: "neutral" };
}

// "SPAN_KIND_SERVER" reads as "Server".
export function spanKindLabel(kind: string): string {
  const name = kind.replace(/^SPAN_KIND_/u, "").toLowerCase();
  return name ? name[0]!.toUpperCase() + name.slice(1) : "—";
}

export function traceHref(projectId: string, traceId: string): string {
  return `/traces/${encodeURIComponent(traceId)}?${new URLSearchParams({ projectId })}`;
}

// The trace list passes its filters to a trace it opens, so the trace page's
// breadcrumb returns to the same list. A trace opened any other way returns
// to the list for its project.
export interface TraceListState {
  traceList: string;
}

export function traceListHref(state: unknown, projectId: string): string {
  const traceList = (state as Partial<TraceListState> | null)?.traceList;
  if (typeof traceList === "string") return traceList ? `/traces?${traceList}` : "/traces";
  return `/traces?${new URLSearchParams({ projectId })}`;
}

export function traceSearchParams(query: TraceQuery): URLSearchParams {
  const params = new URLSearchParams({ projectId: query.projectId, range: query.range });
  if (query.service) params.set("service", query.service);
  if (query.status) params.set("status", query.status);
  if (query.minDurationMs > 0) params.set("minDurationMs", String(query.minDurationMs));
  return params;
}

export async function fetchTraces(query: TraceQuery): Promise<TraceSummary[]> {
  const body = await telemetryJson<{ traces: TraceSummary[] }>(
    `/api/telemetry/traces?${traceSearchParams(query)}`,
  );
  return body.traces;
}

export function fetchTrace(projectId: string, traceId: string): Promise<TraceDetail> {
  return telemetryJson<TraceDetail>(
    `/api/telemetry/traces/${encodeURIComponent(traceId)}?${new URLSearchParams({ projectId })}`,
  );
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  if (milliseconds < 1) return `${Math.round(milliseconds * 1000)} µs`;
  if (milliseconds < 1000) return `${Number(milliseconds.toPrecision(3))} ms`;
  if (milliseconds < 60_000) return `${Number((milliseconds / 1000).toPrecision(3))} s`;
  // Round once, so 119.6 s reads "2 m 0 s" rather than "1 m 60 s".
  const seconds = Math.round(milliseconds / 1000);
  return `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
}

export interface WaterfallRow {
  depth: number;
  // Where the span starts and how long it runs, as percentages of the trace.
  offset: number;
  span: Span;
  width: number;
}

export interface Waterfall {
  // From the first span's start to the last span's end.
  durationMs: number;
  rows: WaterfallRow[];
}

// Orders spans as a tree, each parent before its children and siblings by
// start time, and places each on the trace's timeline. A span whose parent is
// missing from the trace starts a new tree.
export function spanWaterfall(spans: Span[]): Waterfall {
  if (spans.length === 0) return { durationMs: 0, rows: [] };
  const start = (span: Span) => BigInt(span.start_ns);
  const end = (span: Span) => start(span) + BigInt(Math.round(span.duration_ms * 1_000_000));
  const traceStart = spans.reduce((min, span) => (start(span) < min ? start(span) : min), start(spans[0]!));
  const traceEnd = spans.reduce((max, span) => (end(span) > max ? end(span) : max), end(spans[0]!));
  const total = Number(traceEnd - traceStart) || 1;
  const ids = new Set(spans.map((span) => span.span_id));
  const children = new Map<string, Span[]>();
  const roots: Span[] = [];
  for (const span of spans) {
    if (span.parent_span_id && ids.has(span.parent_span_id) && span.parent_span_id !== span.span_id) {
      children.set(span.parent_span_id, [...(children.get(span.parent_span_id) ?? []), span]);
    } else {
      roots.push(span);
    }
  }
  const byStart = (a: Span, b: Span) => (start(a) < start(b) ? -1 : start(a) > start(b) ? 1 : 0);
  const rows: WaterfallRow[] = [];
  const placed = new Set<Span>();
  const visit = (span: Span, depth: number) => {
    if (placed.has(span)) return;
    placed.add(span);
    rows.push({
      depth,
      offset: (Number(start(span) - traceStart) / total) * 100,
      span,
      width: (span.duration_ms * 1_000_000 / total) * 100,
    });
    for (const child of [...(children.get(span.span_id) ?? [])].sort(byStart)) visit(child, depth + 1);
  };
  for (const root of [...roots].sort(byStart)) visit(root, 0);
  // Spans caught in a parent cycle have no root; list them last.
  for (const span of [...spans].sort(byStart)) visit(span, 0);
  return { durationMs: Number(traceEnd - traceStart) / 1_000_000, rows };
}
