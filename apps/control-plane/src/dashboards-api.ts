import { apiErrorMessage } from "./agents-api";
import type {
  ChartData,
  DashboardVariable,
  DashboardVariableValue,
  DashboardWidgetConfig,
  DashboardWidgetFilter,
  DashboardWidgetLayout,
  DashboardWidgetType,
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
  WidgetUnit,
};

export type WidgetData =
  | { chart: ChartData; kind: "chart" }
  | { kind: "logs"; logs: LogRecord[] }
  | { kind: "traces"; traces: TraceSummary[] };

// The instants a query covers, in milliseconds.
export interface QueryWindow {
  since: number;
  until: number;
}

export type VariableValues = Record<string, DashboardVariableValue>;

function windowParams(window: QueryWindow): Record<string, string> {
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

export async function createDashboard(input: { name: string; projectId: string }): Promise<TelemetryDashboard> {
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
  projectId: string;
  type: Exclude<DashboardWidgetType, "markdown">;
  variables: VariableValues;
  window: QueryWindow;
}): Promise<WidgetData> {
  const { window, ...rest } = input;
  return request<WidgetData>("/api/telemetry/widget-data", { body: { ...rest, ...windowParams(window) }, method: "POST" });
}

export async function fetchMetricNames(projectId: string, window: QueryWindow): Promise<MetricName[]> {
  const params = new URLSearchParams({ projectId, ...windowParams(window) });
  return (await request<{ metrics: MetricName[] }>(`/api/telemetry/metric-names?${params}`)).metrics;
}

export async function fetchAttributeKeys(
  projectId: string,
  window: QueryWindow,
  source: AttributeSource,
): Promise<string[]> {
  const params = new URLSearchParams({ projectId, source, ...windowParams(window) });
  const body = await request<{ keys: Array<{ key: string }> }>(`/api/telemetry/attribute-keys?${params}`);
  return body.keys.map((entry) => entry.key);
}

export async function fetchAttributeValues(
  projectId: string,
  window: QueryWindow,
  source: AttributeSource,
  key: string,
): Promise<string[]> {
  return (await fetchAttributeValueCounts(projectId, window, key, [], source)).map((entry) => entry.value);
}

// Values of an attribute with how often each was seen, counting only rows
// that match the filters. A resource attribute is counted across logs and
// spans, which the "metrics" source selects.
export async function fetchAttributeValueCounts(
  projectId: string,
  window: QueryWindow,
  key: string,
  filters: Array<{ key: string; value: string; values?: string[] }>,
  source: AttributeSource = key.startsWith("log.") ? "logs" : key.startsWith("span.") ? "traces" : "metrics",
): Promise<Array<{ count: number; value: string }>> {
  const params = new URLSearchParams({ key, projectId, source, ...windowParams(window) });
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
// right and top to bottom.
export function placeWidget(type: DashboardWidgetType, taken: DashboardWidgetLayout[]): DashboardWidgetLayout {
  const { h, w } = widgetSizes[type];
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

export function formatWidgetValue(value: number | null, unit: WidgetUnit = "none"): string {
  if (value === null || !Number.isFinite(value)) return "—";
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

// A title from the widget's settings, used until someone names it.
export function suggestedWidgetTitle(widget: { config: DashboardWidgetConfig; type: DashboardWidgetType }): string {
  const { config, type } = widget;
  const by = config.groupBy ? ` by ${config.groupBy.replace(/^attr:/u, "")}` : "";
  switch (type) {
    case "timeseries_count":
      return `${config.source === "traces" ? "Spans" : "Logs"}${by}`;
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
