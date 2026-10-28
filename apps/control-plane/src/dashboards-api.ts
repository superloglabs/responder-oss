import { apiErrorMessage } from "./agents-api";
import type {
  ChartData,
  DashboardVariable,
  DashboardVariableValue,
  DashboardWidgetConfig,
  DashboardWidgetFilter,
  DashboardWidgetLayout,
  DashboardWidgetType,
  WidgetAggregation,
  WidgetDisplay,
  WidgetUnit,
} from "../../../packages/core/src/telemetry/dashboards";
import type {
  TelemetryDashboard,
  TelemetryDashboardSummary,
  TelemetryDashboardWidget,
} from "../../../packages/core/src/db/telemetry-dashboards";
import type { AttributeSource } from "../server/telemetry/routes";
import { formatDuration, type LogRecord, type TraceSummary } from "./telemetry-api";

export type {
  ChartData,
  DashboardVariable,
  DashboardVariableValue,
  DashboardWidgetConfig,
  DashboardWidgetFilter,
  DashboardWidgetLayout,
  DashboardWidgetType,
  TelemetryDashboard,
  TelemetryDashboardSummary,
  TelemetryDashboardWidget,
  WidgetAggregation,
  WidgetDisplay,
  WidgetUnit,
};

// A group's value over the window, and over the window before when the
// widget compares with it. Null means nothing had a value.
export interface WidgetValueRow {
  group: string;
  previous?: number | null;
  value: number | null;
}

export type WidgetData =
  | { chart: ChartData; kind: "chart" }
  | { kind: "logs"; logs: LogRecord[] }
  | { kind: "number"; previous?: number | null; value: number | null }
  | { kind: "rows"; rows: WidgetValueRow[] }
  | { kind: "traces"; traces: TraceSummary[] };

// The instants a query covers, in milliseconds.
export interface QueryWindow {
  since: number;
  until: number;
}

export type VariableValues = Record<string, DashboardVariableValue>;

export function windowParams(window: QueryWindow): Record<string, string> {
  return { since: new Date(window.since).toISOString(), until: new Date(window.until).toISOString() };
}

export interface MetricName {
  kind: string;
  name: string;
  unit: string;
}

async function request<T>(url: string, init?: { body?: unknown; keepalive?: boolean; method?: string }): Promise<T> {
  const response = await fetch(url, {
    ...(init?.keepalive ? { keepalive: true } : {}),
    ...(init?.method ? { method: init.method } : {}),
    ...(init?.body === undefined
      ? {}
      : { body: JSON.stringify(init.body), headers: { "content-type": "application/json" } }),
  });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body as T;
}

const base = "/api/telemetry/dashboards";

// Null when the workspace cannot use dashboards.
export async function fetchDashboards(): Promise<TelemetryDashboardSummary[] | null> {
  const response = await fetch(base);
  if (response.status === 404) return null;
  const body = (await response.json().catch(() => null)) as { dashboards: TelemetryDashboardSummary[] } | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body?.dashboards ?? [];
}

export async function fetchDashboard(dashboardId: string): Promise<TelemetryDashboard> {
  return (await request<{ dashboard: TelemetryDashboard }>(`${base}/${encodeURIComponent(dashboardId)}`)).dashboard;
}

export async function createDashboard(input: { name: string }): Promise<TelemetryDashboard> {
  return (await request<{ dashboard: TelemetryDashboard }>(base, { body: input, method: "POST" })).dashboard;
}

export async function updateDashboard(
  dashboardId: string,
  update: { name?: string; variables?: DashboardVariable[] },
): Promise<TelemetryDashboard> {
  return (
    await request<{ dashboard: TelemetryDashboard }>(`${base}/${encodeURIComponent(dashboardId)}`, {
      body: update,
      method: "PATCH",
    })
  ).dashboard;
}

export function deleteDashboard(dashboardId: string): Promise<void> {
  return request(`${base}/${encodeURIComponent(dashboardId)}`, { method: "DELETE" });
}

export interface WidgetDraft {
  config: DashboardWidgetConfig;
  title: string;
  type: DashboardWidgetType;
}

export async function addWidget(
  dashboardId: string,
  widget: WidgetDraft & { layout?: DashboardWidgetLayout },
): Promise<TelemetryDashboardWidget> {
  return (
    await request<{ widget: TelemetryDashboardWidget }>(`${base}/${encodeURIComponent(dashboardId)}/widgets`, {
      body: widget,
      method: "POST",
    })
  ).widget;
}

export async function updateWidget(
  dashboardId: string,
  widgetId: string,
  update: Partial<WidgetDraft>,
): Promise<TelemetryDashboardWidget> {
  return (
    await request<{ widget: TelemetryDashboardWidget }>(
      `${base}/${encodeURIComponent(dashboardId)}/widgets/${encodeURIComponent(widgetId)}`,
      { body: update, method: "PATCH" },
    )
  ).widget;
}

export function deleteWidget(dashboardId: string, widgetId: string): Promise<void> {
  return request(`${base}/${encodeURIComponent(dashboardId)}/widgets/${encodeURIComponent(widgetId)}`, {
    method: "DELETE",
  });
}

// `keepalive` lets a save started as the page closes complete. Browsers
// share a small budget for such requests, so only that save uses it.
export function updateLayout(
  dashboardId: string,
  widgets: Array<{ id: string; layout: DashboardWidgetLayout }>,
  options: { keepalive?: boolean } = {},
): Promise<void> {
  return request(`${base}/${encodeURIComponent(dashboardId)}/layout`, {
    body: { widgets },
    ...(options.keepalive ? { keepalive: true } : {}),
    method: "PATCH",
  });
}

export function fetchWidgetData(input: {
  config: DashboardWidgetConfig;
  type: Exclude<DashboardWidgetType, "markdown">;
  variables: VariableValues;
  window: QueryWindow;
}): Promise<WidgetData> {
  const { window, ...rest } = input;
  return request<WidgetData>("/api/telemetry/widget-data", { body: { ...rest, ...windowParams(window) }, method: "POST" });
}

export async function fetchMetricNames(window: QueryWindow): Promise<MetricName[]> {
  const params = new URLSearchParams(windowParams(window));
  return (await request<{ metrics: MetricName[] }>(`/api/telemetry/metric-names?${params}`)).metrics;
}

export async function fetchAttributeKeys(
  window: QueryWindow,
  source: AttributeSource,
): Promise<string[]> {
  const params = new URLSearchParams({ source, ...windowParams(window) });
  const body = await request<{ keys: Array<{ key: string }> }>(`/api/telemetry/attribute-keys?${params}`);
  return body.keys.map((entry) => entry.key);
}

export async function fetchAttributeValues(
  window: QueryWindow,
  source: AttributeSource,
  key: string,
): Promise<string[]> {
  return (await fetchAttributeValueCounts(window, key, [], source)).map((entry) => entry.value);
}

// Values of an attribute with how often each was seen, counting only rows
// that match the filters. A resource attribute is counted across logs and
// spans, which the "metrics" source selects.
export async function fetchAttributeValueCounts(
  window: QueryWindow,
  key: string,
  filters: Array<{ key: string; value: string; values?: string[] }>,
  source: AttributeSource = key.startsWith("log.") ? "logs" : key.startsWith("span.") ? "traces" : "metrics",
): Promise<Array<{ count: number; value: string }>> {
  const params = new URLSearchParams({ key, source, ...windowParams(window) });
  if (filters.length > 0) params.set("filters", JSON.stringify(filters));
  return (await request<{ values: Array<{ count: number; value: string }> }>(`/api/telemetry/attribute-values?${params}`)).values;
}

// The selected value of each variable before anyone picks one. A
// multi-value variable starts with its default, or with nothing selected,
// which matches every value.
export function defaultVariableValues(variables: DashboardVariable[]): VariableValues {
  return Object.fromEntries(
    variables.map((variable) => [
      variable.name,
      variable.multi
        ? (variable.defaultValue ? [variable.defaultValue] : [])
        : (variable.defaultValue ?? variable.options[0] ?? ""),
    ]),
  );
}

const widgetSizes: Record<DashboardWidgetType, { h: number; w: number }> = {
  log_table: { h: 6, w: 12 },
  markdown: { h: 5, w: 4 },
  timeseries_count: { h: 4, w: 6 },
  timeseries_metric: { h: 4, w: 6 },
  trace_table: { h: 6, w: 12 },
};

// The first free spot for a new widget of this type, reading the grid left to
// right and top to bottom. A single number takes a small tile.
export function placeWidget(
  type: DashboardWidgetType,
  taken: DashboardWidgetLayout[],
  display?: WidgetDisplay,
): DashboardWidgetLayout {
  const { h, w } = display === "number" ? { h: 2, w: 3 } : widgetSizes[type];
  const overlaps = (x: number, y: number) =>
    taken.some((other) => x < other.x + other.w && other.x < x + w && y < other.y + other.h && other.y < y + h);
  for (let y = 0; ; y += 1) {
    for (let x = 0; x + w <= 12; x += 1) {
      if (!overlaps(x, y)) return { h, w, x, y };
    }
  }
}

// Selections after the variables change: each value kept while the variable
// still allows it, otherwise the variable's default.
export function nextVariableValues(variables: DashboardVariable[], current: VariableValues): VariableValues {
  const defaults = defaultVariableValues(variables);
  return Object.fromEntries(
    variables.map((variable) => {
      const selected = current[variable.name];
      const allowed = (value: string) => variable.options.length === 0 || variable.options.includes(value);
      if (selected === undefined) return [variable.name, defaults[variable.name]!];
      if (variable.multi) {
        const list = (Array.isArray(selected) ? selected : [selected]).filter((value) => value !== "" && allowed(value));
        return [variable.name, list.length > 0 || Array.isArray(selected) ? list : defaults[variable.name]!];
      }
      const single = Array.isArray(selected) ? selected[0] : selected;
      return [variable.name, single !== undefined && allowed(single) ? single : defaults[variable.name]!];
    }),
  );
}

// A variable picks from a list when it has options or an attribute to read
// values from, or allows several values. Otherwise its value is typed.
export function variableControl(variable: DashboardVariable): "list" | "typed" {
  return variable.options.length > 0 || variable.attributeKey || variable.multi ? "list" : "typed";
}

// The selected values of a variable as a list; an empty one matches every value.
export function selectedValues(value: DashboardVariableValue | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : value === "" ? [] : [value];
}

// The other variables' selections, as filters on their attributes.
export function variableFilters(
  variables: DashboardVariable[],
  values: VariableValues,
  except: string,
): { filters: Array<{ key: string; value: string; values?: string[] }>; names: string[] } {
  const filters: Array<{ key: string; value: string; values?: string[] }> = [];
  const names: string[] = [];
  for (const variable of variables) {
    if (variable.name === except || !variable.attributeKey) continue;
    const selected = selectedValues(values[variable.name]);
    if (selected.length === 0) continue;
    filters.push({ key: variable.attributeKey, value: selected[0]!, ...(selected.length > 1 ? { values: selected } : {}) });
    names.push(variable.label || variable.name);
  }
  return { filters, names };
}

// Selections kept in the URL as var-name=value, one parameter per value.
// A multi-value variable with nothing selected is var-name with no value.
export function variableValuesFromParams(variables: DashboardVariable[], params: URLSearchParams): VariableValues {
  const fromUrl: VariableValues = {};
  for (const variable of variables) {
    const values = params.getAll(`var-${variable.name}`);
    if (values.length === 0) continue;
    fromUrl[variable.name] = variable.multi ? values.filter(Boolean) : values[0]!;
  }
  return nextVariableValues(variables, { ...defaultVariableValues(variables), ...fromUrl });
}

export function variableParams(values: VariableValues, current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams([...current].filter(([key]) => !key.startsWith("var-")));
  for (const [name, value] of Object.entries(values)) {
    const list = Array.isArray(value) ? value : [value];
    if (list.length === 0) next.append(`var-${name}`, "");
    for (const item of list) next.append(`var-${name}`, item);
  }
  return next;
}

// Widgets whose position or size changed, for one layout update.
export function changedLayouts(
  widgets: Array<{ id: string; layout: DashboardWidgetLayout }>,
  next: Array<{ h: number; i: string; w: number; x: number; y: number }>,
): Array<{ id: string; layout: DashboardWidgetLayout }> {
  const current = new Map(widgets.map((widget) => [widget.id, widget.layout]));
  return next.flatMap((item) => {
    const layout = current.get(item.i);
    if (!layout) return [];
    const moved = { h: item.h, w: item.w, x: item.x, y: item.y };
    return layout.h === moved.h && layout.w === moved.w && layout.x === moved.x && layout.y === moved.y
      ? []
      : [{ id: item.i, layout: moved }];
  });
}

const plainNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });
const compactNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: "compact" });
const byteUnits = ["B", "KB", "MB", "GB", "TB", "PB"];

const dollars = new Intl.NumberFormat("en-US", { currency: "USD", maximumFractionDigits: 2, minimumFractionDigits: 2, style: "currency" });
const compactDollars = new Intl.NumberFormat("en-US", { currency: "USD", maximumFractionDigits: 1, notation: "compact", style: "currency" });
const centDollars = new Intl.NumberFormat("en-US", { currency: "USD", maximumSignificantDigits: 2, style: "currency" });

export function formatWidgetValue(value: number | null, unit: WidgetUnit = "none"): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (unit === "usd") {
    const size = Math.abs(value);
    // Fractions of a cent keep two significant digits, so a call's cost shows.
    if (size >= 100_000) return compactDollars.format(value);
    return size > 0 && size < 0.01 ? centDollars.format(value) : dollars.format(value);
  }
  if (unit === "duration_ms" || unit === "duration_s") {
    const milliseconds = unit === "duration_s" ? value * 1000 : value;
    return milliseconds < 0 ? `-${formatDuration(-milliseconds)}` : formatDuration(milliseconds);
  }
  if (unit === "bytes") {
    let size = Math.abs(value);
    let index = 0;
    while (size >= 1024 && index < byteUnits.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${value < 0 ? "-" : ""}${Number(size.toFixed(index === 0 ? 0 : 1))} ${byteUnits[index]}`;
  }
  const number = Math.abs(value) >= 100_000 ? compactNumber.format(value) : plainNumber.format(value);
  return unit === "percent" ? `${number}%` : number;
}

const changePercent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

// How a value moved since the window before. The short form fits a table
// column.
export function valueChange(
  value: number | null,
  previous: number | null,
  unit: WidgetUnit = "none",
  options: { short?: boolean } = {},
): string {
  if (previous === null) return options.short ? "—" : "No value in the previous period";
  if (value === null) return options.short ? "—" : `Previously ${formatWidgetValue(previous, unit)}`;
  if (value === previous) return "No change";
  if (previous === 0) {
    if (options.short) return "New";
    return `${value > 0 ? "Up" : "Down"} from ${formatWidgetValue(0, unit)}`;
  }
  const change = ((value - previous) / Math.abs(previous)) * 100;
  if (Math.abs(change) < 0.05) return "No change";
  return `${change > 0 ? "▲" : "▼"} ${changePercent.format(Math.abs(change))}%${options.short ? "" : " vs previous period"}`;
}

// Round axis marks from zero (or the lowest value) to at least the highest.
export function axisTicks(minimum: number, maximum: number, count = 4): number[] {
  const low = Math.min(0, minimum);
  const high = maximum > low ? maximum : low + 1;
  const rough = (high - low) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough)!;
  const first = Math.floor(low / step) * step;
  const ticks: number[] = [];
  // The last mark is at or above the highest value, so nothing is cut off.
  for (let tick = first; ticks.length === 0 || ticks[ticks.length - 1]! < high; tick += step) {
    ticks.push(Number(tick.toPrecision(12)));
  }
  return ticks;
}

// Grouped values that do not add up, such as percentiles, are drawn as lines:
// stacking them would show a total that means nothing.
export function widgetChartType(type: DashboardWidgetType, config: DashboardWidgetConfig): "bar" | "line" {
  const additive = !config.aggregation || config.aggregation === "count" || config.aggregation === "sum";
  if (!additive && config.groupBy) return "line";
  return config.chartType ?? (type === "timeseries_metric" ? "line" : "bar");
}

// How each aggregation of logs or spans is named.
export const widgetAggregationLabels: Record<WidgetAggregation, string> = {
  avg: "Average",
  count: "Count",
  count_distinct: "Distinct values",
  max: "Maximum",
  min: "Minimum",
  p50: "Median",
  p90: "90th percentile",
  p95: "95th percentile",
  p99: "99th percentile",
  sum: "Sum",
};

// AI usage read from GenAI spans, as fields to aggregate and to group by.
export const aiMeasureFields = [
  { label: "Cost", value: "ai:cost" },
  { label: "Input tokens", value: "ai:tokens.input" },
  { label: "Uncached input tokens", value: "ai:tokens.input_uncached" },
  { label: "Cache read tokens", value: "ai:tokens.cache_read" },
  { label: "Cache write tokens", value: "ai:tokens.cache_write" },
  { label: "Output tokens", value: "ai:tokens.output" },
  { label: "Reasoning tokens", value: "ai:tokens.reasoning" },
  { label: "Total tokens", value: "ai:tokens.total" },
] as const;
export const aiGroupFields = [
  { label: "AI model", value: "ai:model" },
  { label: "AI provider", value: "ai:provider" },
] as const;
const aiFieldLabels = new Map<string, string>([...aiMeasureFields, ...aiGroupFields].map((field) => [field.value, field.label]));

// A field as people read it: span duration, an AI usage field, or an
// attribute key without its scope prefix.
export function widgetFieldLabel(field: string): string {
  if (field === "duration") return "duration";
  const ai = aiFieldLabels.get(field);
  if (ai) return ai.replace(/^AI /u, "").toLowerCase();
  return field.replace(/^(?:attr:|resource\.|span\.|log\.)/u, "");
}

// A title from the widget's settings, used until someone names it.
export function suggestedWidgetTitle(widget: { config: DashboardWidgetConfig; type: DashboardWidgetType }): string {
  const { config, type } = widget;
  const by = config.groupBy && config.display !== "number" ? ` by ${widgetFieldLabel(config.groupBy)}` : "";
  switch (type) {
    case "timeseries_count": {
      const counted = config.source === "traces" ? "Spans" : "Logs";
      if (!config.aggregation || config.aggregation === "count" || !config.field) return `${counted}${by}`;
      return `${widgetAggregationLabels[config.aggregation]} of ${widgetFieldLabel(config.field)}${by}`;
    }
    case "timeseries_metric":
      return `${config.metricName || "Metric"}${config.aggregation ? ` (${config.aggregation})` : ""}${by}`;
    case "log_table":
      return "Recent logs";
    case "trace_table":
      return "Recent traces";
    case "markdown": {
      const heading = (config.markdown ?? "").split("\n").map((line) => line.trim()).find((line) => line.startsWith("#"));
      return heading?.replace(/^#+\s*/u, "").slice(0, 80) || "Note";
    }
  }
}

// The variables editor's form for one variable.
export interface VariableRow {
  attributeKey: string;
  defaultValue: string;
  label: string;
  multi: boolean;
  name: string;
  options: string;
}

export function variableRow(variable: DashboardVariable): VariableRow {
  return {
    attributeKey: variable.attributeKey ?? "",
    defaultValue: variable.defaultValue ?? "",
    label: variable.label ?? "",
    multi: variable.multi ?? false,
    name: variable.name,
    options: variable.options.join(", "),
  };
}

// The variables a form describes, or why they cannot be saved.
export function variablesFromRows(rows: VariableRow[]): { error: string } | { variables: DashboardVariable[] } {
  const names = new Set<string>();
  const variables: DashboardVariable[] = [];
  for (const row of rows) {
    const name = row.name.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/u.test(name)) {
      return { error: `"${name || "(empty)"}" is not a valid name. Use letters, digits and underscores, starting with a letter.` };
    }
    if (names.has(name)) return { error: `There are two variables called ${name}.` };
    names.add(name);
    const options = [...new Set(row.options.split(",").map((option) => option.trim()).filter(Boolean))];
    const defaultValue = row.defaultValue.trim();
    if (defaultValue && options.length > 0 && !options.includes(defaultValue)) {
      return { error: `The default for ${name} must be one of its options.` };
    }
    variables.push({
      name,
      options,
      ...(row.label.trim() ? { label: row.label.trim() } : {}),
      ...(row.attributeKey.trim() ? { attributeKey: row.attributeKey.trim() } : {}),
      ...(defaultValue ? { defaultValue } : {}),
      ...(row.multi ? { multi: true } : {}),
    });
  }
  return { variables };
}
