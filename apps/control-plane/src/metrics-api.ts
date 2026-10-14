import { apiErrorMessage } from "./agents-api";
import type { AlertForm } from "./alerts-api";
import type { ChartData, DashboardWidgetFilter, WidgetDraft, WidgetUnit } from "./dashboards-api";
import { telemetryRanges, type TelemetryRange } from "./telemetry-api";
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

export async function fetchMetricCatalog(projectId: string, range: TelemetryRange): Promise<MetricCatalogEntry[]> {
  const params = new URLSearchParams({ projectId, range });
  return (await request<{ metrics: MetricCatalogEntry[] }>(`/api/telemetry/metric-catalog?${params}`)).metrics;
}

export async function fetchMetricDimensions(
  projectId: string,
  range: TelemetryRange,
  metric: { kind: MetricKind; name: string },
): Promise<MetricDimension[]> {
  const params = new URLSearchParams({ kind: metric.kind, name: metric.name, projectId, range });
  return (await request<{ dimensions: MetricDimension[] }>(`/api/telemetry/metric-dimensions?${params}`)).dimensions;
}

export async function fetchMetricChart(query: MetricQuery): Promise<ChartData> {
  const body = {
    ...(query.aggregation ? { aggregation: query.aggregation } : {}),
    filters: query.filters,
    ...(query.groupBy ? { groupBy: query.groupBy } : {}),
    metricName: query.name,
    projectId: query.projectId,
    range: query.range,
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
// sum and average.
export function metricAggregationOptions(kind: MetricKind): Array<{ label: string; value: MetricAggregation | "" }> {
  const allowed: MetricAggregation[] = kind === "summary"
    ? ["sum", "avg"]
    : ["sum", "avg", "min", "max", "p95", "p99"];
  return [
    { label: defaultAggregationLabels[kind], value: "" },
    ...allowed.map((value) => ({ label: aggregationLabels[value], value })),
  ];
}

export function metricAggregationLabel(kind: MetricKind, aggregation: MetricAggregation | ""): string {
  return aggregation ? aggregationLabels[aggregation] : defaultAggregationLabels[kind];
}

// Durations are mostly read as a percentile, so histograms open on p95.
export function initialAggregation(kind: MetricKind): MetricAggregation | "" {
  return isHistogram(kind) ? "p95" : "";
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

// The part of a metric name before its first dot groups related metrics.
export function metricNamespace(name: string): string {
  const dot = name.indexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export interface MetricGroup {
  metrics: MetricCatalogEntry[];
  namespace: string;
}

export function groupMetrics(metrics: MetricCatalogEntry[]): MetricGroup[] {
  const groups = new Map<string, MetricCatalogEntry[]>();
  for (const metric of [...metrics].sort((a, b) => a.name.localeCompare(b.name))) {
    const namespace = metricNamespace(metric.name);
    groups.set(namespace, [...(groups.get(namespace) ?? []), metric]);
  }
  return [...groups].map(([namespace, grouped]) => ({ metrics: grouped, namespace }));
}

// Metrics matching a search across names, descriptions, units and attribute keys.
export function searchMetrics(metrics: MetricCatalogEntry[], search: string): MetricCatalogEntry[] {
  const terms = search.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return metrics;
  return metrics.filter((metric) => {
    const text = [metric.name, metric.description, metric.unit, ...metric.attributes]
      .join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
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
  projectId: string;
  range: TelemetryRange;
}

const rangeValues = new Set<string>(telemetryRanges.map((range) => range.value));
const aggregationValues = new Set<string>(Object.keys(aggregationLabels));

// The explorer keeps its query in the URL, so a graph can be shared and the
// back button restores it. Each filter is one `filter=key=value` parameter.
export function metricQueryFromParams(params: URLSearchParams): MetricQuery | null {
  const name = params.get("metric") ?? "";
  const kind = params.get("kind") ?? "";
  if (!name || !(metricKinds as string[]).includes(kind)) return null;
  const range = params.get("range") ?? "";
  const aggregation = params.get("aggregation");
  return {
    aggregation: aggregation === null
      ? initialAggregation(kind as MetricKind)
      : aggregationValues.has(aggregation) ? (aggregation as MetricAggregation) : "",
    chartType: params.get("chart") === "bar" ? "bar" : "line",
    filters: params.getAll("filter").flatMap((filter) => {
      const separator = filter.indexOf("=");
      return separator > 0 ? [{ key: filter.slice(0, separator), value: filter.slice(separator + 1) }] : [];
    }),
    groupBy: params.get("by") ?? "",
    kind: kind as MetricKind,
    name,
    projectId: params.get("projectId") ?? "",
    range: rangeValues.has(range) ? (range as TelemetryRange) : "1h",
  };
}

export function metricQueryParams(query: MetricQuery): URLSearchParams {
  const params = new URLSearchParams({ kind: query.kind, metric: query.name });
  if (query.projectId) params.set("projectId", query.projectId);
  if (query.range !== "1h") params.set("range", query.range);
  if (query.aggregation !== initialAggregation(query.kind)) params.set("aggregation", query.aggregation);
  if (query.groupBy) params.set("by", query.groupBy);
  for (const filter of query.filters) params.append("filter", `${filter.key}=${filter.value}`);
  if (query.chartType === "bar") params.set("chart", "bar");
  return params;
}

export function metricExplorerHref(
  metric: { kind: MetricKind; name: string },
  context: { projectId: string; range: TelemetryRange },
): string {
  const params = metricQueryParams({
    aggregation: initialAggregation(metric.kind),
    chartType: "line",
    filters: [],
    groupBy: "",
    kind: metric.kind,
    name: metric.name,
    projectId: context.projectId,
    range: context.range,
  });
  return `/metrics/explore?${params}`;
}

export function metricChartTitle(query: MetricQuery): string {
  const by = query.groupBy ? ` by ${dimensionLabel(query.groupBy)}` : "";
  return `${metricAggregationLabel(query.kind, query.aggregation)} of ${query.name}${by}`;
}

// The graph as a dashboard widget.
export function metricWidgetDraft(query: MetricQuery, unit: string): WidgetDraft {
  return {
    config: {
      ...(query.aggregation ? { aggregation: query.aggregation } : {}),
      chartType: query.chartType,
      filter: { resourceAttrs: query.filters },
      ...(query.groupBy ? { groupBy: query.groupBy } : {}),
      metricName: query.name,
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
    metricName: query.name,
    name: query.name,
    perGroup: Boolean(query.groupBy),
    projectId: query.projectId,
    source: "metric",
  };
}
