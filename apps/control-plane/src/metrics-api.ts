import { apiErrorMessage } from "./agents-api";
import type { AlertForm } from "./alerts-api";
import { cloudWatchMetricName } from "./cloudwatch-metric-names";
import {
  defaultTimeRange,
  sameTimeRange,
  timeRangeFromParams,
  timeRangeParams,
  type DashboardTimeRange,
} from "./dashboard-time-range";
import {
  windowParams,
  type ChartData,
  type DashboardWidgetFilter,
  type QueryWindow,
  type WidgetDraft,
  type WidgetUnit,
} from "./dashboards-api";
import type {
  MetricAggregation,
  MetricCatalogEntry,
  MetricDimension,
  MetricKind,
} from "../../../packages/core/src/telemetry/query";

export type { MetricAggregation, MetricCatalogEntry, MetricDimension, MetricKind };

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined
    ? undefined
    : { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" });
  const parsed = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) throw new Error(apiErrorMessage(parsed, response.status));
  return parsed as T;
}

export async function fetchMetricCatalog(window: QueryWindow): Promise<MetricCatalogEntry[]> {
  const params = new URLSearchParams(windowParams(window));
  return (await request<{ metrics: MetricCatalogEntry[] }>(`/api/telemetry/metric-catalog?${params}`)).metrics;
}

export async function fetchMetricDimensions(
  window: QueryWindow,
  metric: { kind: MetricKind; name: string; unit: string | null },
): Promise<MetricDimension[]> {
  const params = new URLSearchParams({ kind: metric.kind, name: metric.name, ...windowParams(window) });
  if (metric.unit !== null) params.set("unit", metric.unit);
  return (await request<{ dimensions: MetricDimension[] }>(`/api/telemetry/metric-dimensions?${params}`)).dimensions;
}

export async function fetchMetricChart(query: MetricQuery, window: QueryWindow): Promise<ChartData> {
  const body = {
    ...(query.aggregation ? { aggregation: query.aggregation } : {}),
    filters: query.filters,
    ...(query.groupBy ? { groupBy: query.groupBy } : {}),
    // A name can be sent as more than one kind or unit; chart only the
    // chosen one.
    kind: query.kind,
    metricName: query.name,
    ...windowParams(window),
    ...(query.unit !== null ? { unit: query.unit } : {}),
  };
  return (await request<{ chart: ChartData }>("/api/telemetry/metric-series", body)).chart;
}

const kindLabels: Record<MetricKind, string> = {
  exponential_histogram: "Exp. histogram",
  gauge: "Gauge",
  histogram: "Histogram",
  sum: "Sum",
  summary: "Summary",
};

export function metricKindLabel(kind: MetricKind): string {
  return kindLabels[kind];
}

export const metricKinds = Object.keys(kindLabels) as MetricKind[];

function isHistogram(kind: MetricKind): boolean {
  return kind === "histogram" || kind === "exponential_histogram";
}

// What the server computes when no aggregation is chosen.
const defaultAggregationLabels: Record<MetricKind, string> = {
  exponential_histogram: "Count",
  gauge: "Average",
  histogram: "Count",
  sum: "Sum",
  summary: "Average",
};

const aggregationLabels: Record<MetricAggregation, string> = {
  avg: "Average",
  max: "Maximum",
  min: "Minimum",
  p95: "95th percentile",
  p99: "99th percentile",
  sum: "Sum",
};

// Summaries keep precomputed quantiles that cannot be combined, so they only
// sum and average. Their server default averages each point's sum, not the
// observations, so they always name an aggregation.
export function metricAggregationOptions(kind: MetricKind): Array<{ label: string; value: MetricAggregation | "" }> {
  const allowed: MetricAggregation[] = kind === "summary"
    ? ["sum", "avg"]
    : ["sum", "avg", "min", "max", "p95", "p99"];
  return [
    ...(kind === "summary" ? [] : [{ label: defaultAggregationLabels[kind], value: "" as const }]),
    ...allowed.map((value) => ({ label: aggregationLabels[value], value })),
  ];
}

export function metricAggregationLabel(kind: MetricKind, aggregation: MetricAggregation | ""): string {
  return aggregation ? aggregationLabels[aggregation] : defaultAggregationLabels[kind];
}

// Durations are mostly read as a percentile, so histograms open on p95.
// Summaries open on the average of their observations.
export function initialAggregation(kind: MetricKind): MetricAggregation | "" {
  if (isHistogram(kind)) return "p95";
  return kind === "summary" ? "avg" : "";
}

// How chart values read, from the metric's OpenTelemetry unit. A histogram's
// default aggregation counts points, which have no unit.
export function metricWidgetUnit(metric: { kind: MetricKind; unit: string }, aggregation: MetricAggregation | ""): WidgetUnit {
  if (isHistogram(metric.kind) && !aggregation) return "none";
  switch (metric.unit) {
    case "s":
      return "duration_s";
    case "ms":
      return "duration_ms";
    case "By":
      return "bytes";
    case "%":
      return "percent";
    default:
      return "none";
  }
}

// The part of a metric name before its first dot groups related metrics. A
// CloudWatch metric groups under its AWS service.
export function metricNamespace(name: string): string {
  const cloudWatch = cloudWatchMetricName(name);
  if (cloudWatch) return cloudWatch.group;
  const dot = name.indexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

// How a metric reads in a list: a CloudWatch metric by its readable title and
// description, any other metric by its own name and description.
export function metricDisplay(metric: { description: string; name: string }): { description: string; title: string } {
  const cloudWatch = cloudWatchMetricName(metric.name);
  if (!cloudWatch) return { description: metric.description, title: metric.name };
  return { description: metric.description || cloudWatch.description, title: cloudWatch.title };
}

// A metric's name where no group gives its context, such as a chart title.
export function metricLabel(name: string): string {
  return cloudWatchMetricName(name)?.standalone ?? name;
}

function isCloudMetric(metric: MetricCatalogEntry): boolean {
  return cloudWatchMetricName(metric.name) !== null;
}

function byTitle(a: MetricCatalogEntry, b: MetricCatalogEntry): number {
  return metricDisplay(a).title.localeCompare(metricDisplay(b).title) || a.name.localeCompare(b.name);
}

export interface MetricGroup {
  // An AWS service's CloudWatch metrics.
  cloud: boolean;
  metrics: MetricCatalogEntry[];
  namespace: string;
}

// Application namespaces come first, then AWS services.
export function groupMetrics(metrics: MetricCatalogEntry[]): MetricGroup[] {
  const groups = new Map<string, MetricCatalogEntry[]>();
  const sorted = [...metrics].sort((a, b) => Number(isCloudMetric(a)) - Number(isCloudMetric(b)) || byTitle(a, b));
  for (const metric of sorted) {
    const namespace = metricNamespace(metric.name);
    groups.set(namespace, [...(groups.get(namespace) ?? []), metric]);
  }
  return [...groups]
    .map(([namespace, grouped]) => ({ cloud: isCloudMetric(grouped[0]!), metrics: grouped, namespace }))
    .sort((a, b) => Number(a.cloud) - Number(b.cloud) || a.namespace.localeCompare(b.namespace));
}

// The catalog table's group: one for the application's own metrics and one
// for each AWS service.
export function metricCatalogGroup(metric: MetricCatalogEntry): string {
  return cloudWatchMetricName(metric.name)?.group ?? "Application";
}

// Catalog rows in group order, or null groups when every metric is the
// application's own.
export function groupMetricCatalog(metrics: MetricCatalogEntry[]): { grouped: boolean; rows: MetricCatalogEntry[] } {
  if (!metrics.some(isCloudMetric)) return { grouped: false, rows: metrics };
  const order = (metric: MetricCatalogEntry) => (isCloudMetric(metric) ? metricCatalogGroup(metric) : "");
  return {
    grouped: true,
    rows: [...metrics].sort((a, b) =>
      order(a).localeCompare(order(b)) || (isCloudMetric(a) ? byTitle(a, b) : 0)),
  };
}

// Metrics matching a search across names, titles, descriptions, units and
// attribute keys.
export function searchMetrics(metrics: MetricCatalogEntry[], search: string): MetricCatalogEntry[] {
  const terms = search.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return metrics;
  return metrics.filter((metric) => {
    const display = metricDisplay(metric);
    const text = [metric.name, metricLabel(metric.name), display.title, display.description, metric.unit, ...metric.attributes]
      .join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

// The catalog rows a search, type and service select. Services come from
// sampled details, so a metric whose details did not read every point stays
// listed under every service rather than disappearing from it.
export function filterMetricCatalog(
  metrics: MetricCatalogEntry[],
  filters: { kind: string; search: string; service: string },
): MetricCatalogEntry[] {
  return searchMetrics(metrics, filters.search).filter(
    (metric) =>
      (!filters.kind || metric.kind === filters.kind) &&
      (!filters.service || !metric.servicesComplete || metric.services.includes(filters.service)),
  );
}

// "attr:http.route" and "resource.service.name" read as their attribute key.
export function dimensionLabel(key: string): string {
  if (key.startsWith("attr:")) return key.slice("attr:".length);
  if (key.startsWith("resource.")) return key.slice("resource.".length);
  return key;
}

// A bucket size as "30s", "5m", "1h" or "1d".
export function formatStep(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

export interface SeriesStats {
  average: number | null;
  last: number | null;
  maximum: number | null;
}

export function seriesStats(values: Array<number | null>): SeriesStats {
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (present.length === 0) return { average: null, last: null, maximum: null };
  return {
    average: present.reduce((sum, value) => sum + value, 0) / present.length,
    last: present[present.length - 1]!,
    maximum: Math.max(...present),
  };
}

export interface MetricQuery {
  aggregation: MetricAggregation | "";
  chartType: "bar" | "line";
  filters: DashboardWidgetFilter[];
  groupBy: string;
  kind: MetricKind;
  name: string;
  range: DashboardTimeRange;
  // With the name and kind, picks one metric. Null reads every unit, for
  // links that predate it.
  unit: string | null;
}

// The most filters a graph can carry, as for a dashboard widget.
export const maxMetricFilters = 50;

const aggregationValues = new Set<string>(Object.keys(aggregationLabels));

// The explorer keeps its query in the URL, so a graph can be shared and the
// back button restores it. Each filter is one `filter=key=value` parameter.
export function metricQueryFromParams(params: URLSearchParams): MetricQuery | null {
  const name = params.get("metric") ?? "";
  const kind = params.get("kind") ?? "";
  if (!name || !(metricKinds as string[]).includes(kind)) return null;
  const aggregation = params.get("aggregation");
  const chosen = aggregation !== null && aggregationValues.has(aggregation) ? (aggregation as MetricAggregation) : "";
  const offered = metricAggregationOptions(kind as MetricKind).some((option) => option.value === chosen);
  return {
    // An aggregation the kind does not offer falls back to where it opens.
    aggregation: aggregation === null || !offered ? initialAggregation(kind as MetricKind) : chosen,
    chartType: params.get("chart") === "bar" ? "bar" : "line",
    filters: params.getAll("filter").flatMap((filter) => {
      const separator = filter.indexOf("=");
      return separator > 0 ? [{ key: filter.slice(0, separator), value: filter.slice(separator + 1) }] : [];
    }).slice(0, maxMetricFilters),
    groupBy: params.get("by") ?? "",
    kind: kind as MetricKind,
    name,
    range: timeRangeFromParams(params),
    unit: params.get("unit"),
  };
}

// The time range a metrics page keeps in its URL, left out when it is the
// default last hour.
export function metricRangeParams(range: DashboardTimeRange, current = new URLSearchParams()): URLSearchParams {
  if (!sameTimeRange(range, defaultTimeRange)) return timeRangeParams(range, current);
  const next = new URLSearchParams(current);
  for (const name of ["range", "from", "to"]) next.delete(name);
  return next;
}

export function metricQueryParams(query: MetricQuery): URLSearchParams {
  const base = new URLSearchParams({ kind: query.kind, metric: query.name });
  if (query.unit !== null) base.set("unit", query.unit);
  const params = metricRangeParams(query.range, base);
  if (query.aggregation !== initialAggregation(query.kind)) params.set("aggregation", query.aggregation);
  if (query.groupBy) params.set("by", query.groupBy);
  for (const filter of query.filters) params.append("filter", `${filter.key}=${filter.value}`);
  if (query.chartType === "bar") params.set("chart", "bar");
  return params;
}

export function metricExplorerHref(
  metric: { kind: MetricKind; name: string; unit: string },
  context: { range: DashboardTimeRange },
): string {
  const params = metricQueryParams({
    aggregation: initialAggregation(metric.kind),
    chartType: "line",
    filters: [],
    groupBy: "",
    kind: metric.kind,
    name: metric.name,
    range: context.range,
    unit: metric.unit,
  });
  return `/metrics/explore?${params}`;
}

export function metricChartTitle(query: MetricQuery): string {
  const by = query.groupBy ? ` by ${dimensionLabel(query.groupBy)}` : "";
  return `${metricAggregationLabel(query.kind, query.aggregation)} of ${metricLabel(query.name)}${by}`;
}

// The graph as a dashboard widget.
export function metricWidgetDraft(query: MetricQuery, unit: string): WidgetDraft {
  return {
    config: {
      ...(query.aggregation ? { aggregation: query.aggregation } : {}),
      chartType: query.chartType,
      filter: { resourceAttrs: query.filters },
      ...(query.groupBy ? { groupBy: query.groupBy } : {}),
      metricKind: query.kind,
      metricName: query.name,
      ...(query.unit !== null ? { metricUnit: query.unit } : {}),
      unit: metricWidgetUnit({ kind: query.kind, unit }, query.aggregation),
    },
    title: metricChartTitle(query),
    type: "timeseries_metric",
  };
}

// The graph as a new alert. Metric alerts sum or average; a sum, chosen or
// a counter's default, stays a sum and anything else starts from the average.
export function metricAlertDraft(query: MetricQuery): Partial<AlertForm> {
  const sums = query.aggregation === "sum" || (!query.aggregation && query.kind === "sum");
  return {
    aggregation: sums ? "sum" : "avg",
    filters: query.filters,
    groupBy: query.groupBy,
    metricKind: query.kind,
    metricName: query.name,
    metricUnit: query.unit,
    name: metricLabel(query.name),
    perGroup: Boolean(query.groupBy),
    source: "metric",
  };
}
