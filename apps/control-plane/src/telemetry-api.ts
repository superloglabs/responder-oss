import { apiErrorMessage } from "./agents-api";
import { resolveTimeRange, timeRangeFromParams, timeRangeParams, type DashboardTimeRange } from "./dashboard-time-range";
import type { TelemetryRange, TelemetrySignal } from "../server/telemetry/routes";
import type { OverviewDetails, TelemetryOverview } from "../../../packages/core/src/telemetry/overview";

export type { TelemetryRange, TelemetrySignal };
export type {
  OverviewAi,
  OverviewDetails,
  OverviewLogBucket,
  OverviewService,
  OverviewTraceBucket,
  OverviewTraces,
  TelemetryOverview,
} from "../../../packages/core/src/telemetry/overview";

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

async function telemetryJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body as T;
}

// False when the workspace cannot read telemetry.
export async function fetchTelemetryAvailable(): Promise<boolean> {
  const response = await fetch("/api/telemetry/status");
  if (response.status === 404) return false;
  const body = (await response.json().catch(() => null)) as { available: boolean } | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body?.available ?? false;
}

export async function fetchServices(
  range: TelemetryRange,
  // "all" includes services that only send metrics.
  signal: TelemetrySignal | "all" = "logs",
): Promise<string[]> {
  const params = new URLSearchParams({ range, signal });
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

export function formatTelemetryTime(value: string, timeZone?: string): string {
  const date = logTimestamp(value);
  if (!date) return value;
  return date.toLocaleString(undefined, {
    ...(timeZone ? { timeZone } : {}),
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

export function traceHref(traceId: string): string {
  return `/traces/${encodeURIComponent(traceId)}`;
}

// The trace list passes its filters to a trace it opens, so the trace page's
// breadcrumb returns to the same list. A trace opened any other way returns
// to the unfiltered list.
export interface TraceListState {
  traceList: string;
}

export function traceListHref(state: unknown): string {
  const traceList = (state as Partial<TraceListState> | null)?.traceList;
  return typeof traceList === "string" && traceList ? `/traces/search?${traceList}` : "/traces/search";
}

export function fetchTrace(traceId: string): Promise<TraceDetail> {
  return telemetryJson<TraceDetail>(`/api/telemetry/traces/${encodeURIComponent(traceId)}`);
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

// An attribute filter as the explorers keep it in the URL: `key=value` or
// `key!=value`. Keys are scoped, such as `log.http.route` or
// `resource.deployment.environment`; `field.trace_id` matches a trace ID.
export interface ExplorerFilter {
  key: string;
  op: "eq" | "neq";
  value: string;
}

export function parseExplorerFilter(text: string): ExplorerFilter | null {
  const match = /^([^=!]{1,200})(!?=)(.{0,500})$/su.exec(text.trim());
  const key = match?.[1]?.trim();
  if (!match || !key) return null;
  return { key, op: match[2] === "!=" ? "neq" : "eq", value: (match[3] ?? "").trim() };
}

export function explorerFilterText(filter: ExplorerFilter): string {
  return `${filter.key}${filter.op === "neq" ? "!=" : "="}${filter.value}`;
}

const environmentKey = "resource.deployment.environment";

// The environment picker sets one equality filter on the environment.
export function environmentFilter(filters: ExplorerFilter[]): string {
  return filters.find((filter) => filter.key === environmentKey && filter.op === "eq")?.value ?? "";
}

export function withEnvironment(filters: ExplorerFilter[], environment: string): ExplorerFilter[] {
  const rest = filters.filter((filter) => !(filter.key === environmentKey && filter.op === "eq"));
  return environment ? [...rest, { key: environmentKey, op: "eq", value: environment }] : rest;
}

export interface LogExplorerQuery {
  // Attribute keys shown as extra facets.
  facets: string[];
  filters: ExplorerFilter[];
  range: DashboardTimeRange;
  search: string;
  services: string[];
  severities: string[];
}

export interface TraceExplorerQuery {
  facets: string[];
  filters: ExplorerFilter[];
  minDurationMs: number;
  operations: string[];
  range: TelemetryRange;
  services: string[];
  statuses: string[];
}

const explorerRanges = new Set<string>(["15m", "1h", "6h", "24h", "7d"]);

function explorerRange(params: URLSearchParams): TelemetryRange {
  const range = params.get("range") ?? "";
  return explorerRanges.has(range) ? (range as TelemetryRange) : "1h";
}

function uniqueValues(params: URLSearchParams, name: string): string[] {
  return [...new Set(params.getAll(name).map((value) => value.trim()).filter(Boolean))];
}

function explorerFilters(params: URLSearchParams): ExplorerFilter[] {
  return params.getAll("filter").flatMap((text) => {
    const filter = parseExplorerFilter(text);
    return filter ? [filter] : [];
  });
}

// The explorers keep their query in the page URL, under the same names the
// API reads, so a link reopens the same view.
export function logExplorerQuery(params: URLSearchParams): LogExplorerQuery {
  return {
    facets: uniqueValues(params, "facet"),
    filters: explorerFilters(params),
    range: timeRangeFromParams(params),
    search: params.get("search")?.trim() ?? "",
    services: uniqueValues(params, "service"),
    severities: uniqueValues(params, "severity").map((value) => value.toUpperCase()),
  };
}

export function traceExplorerQuery(params: URLSearchParams): TraceExplorerQuery {
  const minDurationMs = Number(params.get("minDurationMs"));
  return {
    facets: uniqueValues(params, "facet"),
    filters: explorerFilters(params),
    minDurationMs: Number.isFinite(minDurationMs) && minDurationMs > 0 ? minDurationMs : 0,
    operations: uniqueValues(params, "operation"),
    range: explorerRange(params),
    services: uniqueValues(params, "service"),
    // The trace list's older links say `status=error`.
    statuses: uniqueValues(params, "status").map((value) => (value === "error" ? "STATUS_CODE_ERROR" : value)),
  };
}

function appendAll(params: URLSearchParams, name: string, values: string[]) {
  for (const value of values) params.append(name, value);
}

export function logExplorerParams(query: LogExplorerQuery): URLSearchParams {
  const params = timeRangeParams(query.range, new URLSearchParams());
  if (query.search) params.set("search", query.search);
  appendAll(params, "service", query.services);
  appendAll(params, "severity", query.severities);
  appendAll(params, "filter", query.filters.map(explorerFilterText));
  appendAll(params, "facet", query.facets);
  return params;
}

export function traceExplorerParams(query: TraceExplorerQuery): URLSearchParams {
  const params = new URLSearchParams();
  params.set("range", query.range);
  appendAll(params, "service", query.services);
  appendAll(params, "operation", query.operations);
  appendAll(params, "status", query.statuses);
  if (query.minDurationMs > 0) params.set("minDurationMs", String(query.minDurationMs));
  appendAll(params, "filter", query.filters.map(explorerFilterText));
  appendAll(params, "facet", query.facets);
  return params;
}

export interface CountBucket {
  bucket: string;
  count: number;
  group: string;
}

export interface Histogram {
  buckets: CountBucket[];
  since: string;
  stepMs: number;
  until: string;
}

export interface FacetCount {
  group: string;
  value: number;
}

export interface LogFacets {
  attributes: Record<string, FacetCount[]>;
  services: FacetCount[];
  severities: FacetCount[];
}

export interface TraceFacets {
  attributes: Record<string, FacetCount[]>;
  operations: FacetCount[];
  services: FacetCount[];
  statuses: FacetCount[];
}

// The log API takes the window as `since` and `until`; a range that ends now
// resolves when the request is made.
export function logApiParams(query: LogExplorerQuery, now = Date.now()): URLSearchParams {
  const params = logExplorerParams(query);
  const { since, until } = resolveTimeRange(query.range, now);
  for (const name of ["range", "from", "to"]) params.delete(name);
  params.set("since", new Date(since).toISOString());
  params.set("until", new Date(until).toISOString());
  return params;
}

export function fetchExplorerLogs(query: LogExplorerQuery): Promise<LogRecord[]> {
  return telemetryJson<{ logs: LogRecord[] }>(`/api/telemetry/logs?${logApiParams(query)}`).then((body) => body.logs);
}

export function fetchLogHistogram(query: LogExplorerQuery): Promise<Histogram> {
  return telemetryJson<Histogram>(`/api/telemetry/logs/histogram?${logApiParams(query)}`);
}

export function fetchLogFacets(query: LogExplorerQuery): Promise<LogFacets> {
  return telemetryJson<LogFacets>(`/api/telemetry/logs/facets?${logApiParams(query)}`);
}

export function fetchExplorerTraces(query: TraceExplorerQuery): Promise<TraceSummary[]> {
  return telemetryJson<{ traces: TraceSummary[] }>(`/api/telemetry/traces?${traceExplorerParams(query)}`).then(
    (body) => body.traces,
  );
}

export function fetchTraceHistogram(query: TraceExplorerQuery): Promise<Histogram> {
  return telemetryJson<Histogram>(`/api/telemetry/traces/histogram?${traceExplorerParams(query)}`);
}

export function fetchTraceFacets(query: TraceExplorerQuery): Promise<TraceFacets> {
  return telemetryJson<TraceFacets>(`/api/telemetry/traces/facets?${traceExplorerParams(query)}`);
}

export interface TraceOverviewStats {
  errors: number;
  p95_ms: number;
  requests: number;
}

export interface TraceOverview {
  dependencies: Array<TraceOverviewStats & { name: string }>;
  errors: Array<{ first_seen: string; message: string; service: string; span_name: string; spans: number; traces: number }>;
  operations: Array<TraceOverviewStats & { name: string }>;
  series: Array<TraceOverviewStats & { bucket: string }>;
  totals: TraceOverviewStats;
}

export interface TraceOverviewQuery {
  filters: ExplorerFilter[];
  range: TelemetryRange;
  service: string;
}

export function fetchTraceOverview(
  query: TraceOverviewQuery,
): Promise<{ overview: TraceOverview; since: string; stepMs: number; until: string }> {
  const params = new URLSearchParams({ range: query.range });
  if (query.service) params.set("service", query.service);
  appendAll(params, "filter", query.filters.map(explorerFilterText));
  return telemetryJson(`/api/telemetry/traces/overview?${params}`);
}

// What each service sent over the window, split into equal buckets.
export function fetchTelemetryOverview(
  range: TelemetryRange,
): Promise<{ overview: TelemetryOverview; since: string; until: string }> {
  return telemetryJson(`/api/telemetry/overview?${new URLSearchParams({ range })}`);
}

export function fetchTelemetryOverviewDetails(range: TelemetryRange): Promise<{ details: OverviewDetails }> {
  return telemetryJson(`/api/telemetry/overview/details?${new URLSearchParams({ range })}`);
}

export interface HistogramBar<Series extends string> {
  // False for derived metrics in buckets without observations.
  hasData?: boolean;
  counts: Record<Series, number>;
  start: Date;
  total: number;
}

// Every bucket in the window, empty ones included, with each group's count
// added to the series `seriesOf` names for it.
export function histogramBars<Series extends string>(
  histogram: Histogram,
  series: readonly Series[],
  seriesOf: (group: string) => Series,
): Array<HistogramBar<Series>> {
  const since = Date.parse(histogram.since);
  const until = Date.parse(histogram.until);
  const step = histogram.stepMs;
  if (!Number.isFinite(since) || !Number.isFinite(until) || step <= 0) return [];
  const empty = () => Object.fromEntries(series.map((name) => [name, 0])) as Record<Series, number>;
  const bars = new Map<number, HistogramBar<Series>>();
  for (let start = Math.floor(since / step) * step; start <= until; start += step) {
    bars.set(start, { counts: empty(), start: new Date(start), total: 0 });
  }
  for (const bucket of histogram.buckets) {
    const start = logTimestamp(bucket.bucket)?.getTime();
    const bar = start === undefined ? undefined : bars.get(Math.floor(start / step) * step);
    if (!bar) continue;
    bar.counts[seriesOf(bucket.group)] += bucket.count;
    bar.total += bucket.count;
  }
  return [...bars.values()];
}

// A log level as the explorer charts and lists it.
export type LevelSeries = "error" | "warn" | "other";

export function levelSeries(severity: string): LevelSeries {
  const tone = severityTextTone(severity);
  return tone === "danger" ? "error" : tone === "warning" ? "warn" : "other";
}

// "ERROR" reads as "Error"; a log without a level reads as "Unset".
export function levelLabel(severity: string): string {
  const text = severity.trim();
  return text ? text[0]!.toUpperCase() + text.slice(1).toLowerCase() : "Unset";
}

// Time of day with milliseconds, and the date for windows over a day.
export function formatExplorerTime(value: string, withDate: boolean, timeZone?: string): string {
  const date = logTimestamp(value);
  if (!date) return value;
  const zone = timeZone ? { timeZone } : {};
  const time = date.toLocaleTimeString(undefined, {
    ...zone,
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    second: "2-digit",
  });
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  const day = withDate ? `${date.toLocaleDateString(undefined, { ...zone, day: "numeric", month: "short" })}, ` : "";
  return `${day}${time}.${milliseconds}`;
}

export function traceSearchHref(params: URLSearchParams): string {
  const query = params.toString();
  return query ? `/traces/search?${query}` : "/traces/search";
}

const telemetryRangeMinutes: Record<TelemetryRange, number> = { "15m": 15, "1h": 60, "6h": 360, "24h": 1_440, "7d": 10_080 };

// The last `range` up to now, for lookups that take an explicit window.
export function telemetryRangeWindow(range: TelemetryRange, now = Date.now()): { since: number; until: number } {
  return { since: now - telemetryRangeMinutes[range] * 60_000, until: now };
}
