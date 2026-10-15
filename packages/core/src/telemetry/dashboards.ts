import { z } from "zod";

// Dashboards over a telemetry project. Widget configs keep the shape Superlog
// dashboards stored, so existing dashboards can be copied over unchanged.

export const dashboardWidgetTypes = [
  "timeseries_count",
  "timeseries_metric",
  "log_table",
  "trace_table",
  "markdown",
] as const;
export type DashboardWidgetType = (typeof dashboardWidgetTypes)[number];

const widgetFilterSchema = z.object({
  // Keys may be prefixed with resource., span., log. or field.; a bare key is
  // a resource attribute. Values may reference dashboard variables.
  key: z.string().trim().min(1).max(200),
  op: z.enum(["eq", "neq", "not_contains"]).optional(),
  value: z.string().max(500),
});
export type DashboardWidgetFilter = z.infer<typeof widgetFilterSchema>;
// The most filters a widget, and so a metrics explorer graph, can carry.
export const maxWidgetFilters = 50;

export const metricAggregations = ["sum", "avg", "min", "max", "p95", "p99"] as const;
// Logs and spans are counted by default, or summed up from a field. Metrics
// take the subset above.
export const widgetAggregations = ["count", "count_distinct", "sum", "avg", "min", "max", "p50", "p90", "p95", "p99"] as const;
export type WidgetAggregation = (typeof widgetAggregations)[number];
export const widgetUnits = ["none", "duration_ms", "duration_s", "bytes", "percent"] as const;
export type WidgetUnit = (typeof widgetUnits)[number];
// How a chart widget shows its query: over time, as one number for the
// window, or as one value per group.
export const widgetDisplays = ["timeseries", "number", "bar_list", "table"] as const;
export type WidgetDisplay = (typeof widgetDisplays)[number];

export const dashboardWidgetConfigSchema = z.object({
  aggregation: z.enum(widgetAggregations).optional(),
  chartType: z.enum(["line", "bar"]).optional(),
  // A number or a table of groups can show the window before this one too.
  compare: z.enum(["previous_period"]).optional(),
  description: z.string().max(500).optional(),
  display: z.enum(widgetDisplays).optional(),
  // What a log or span aggregation reads: `duration`, or an attribute key.
  field: z.string().trim().max(200).optional(),
  filter: z.object({ resourceAttrs: z.array(widgetFilterSchema).max(maxWidgetFilters).optional() }).default({}),
  groupBy: z.string().trim().max(200).optional(),
  legendPosition: z.enum(["side", "bottom"]).optional(),
  // Series kept before the rest roll into "Other", or rows in a table.
  limit: z.number().int().positive().max(500).optional(),
  markdown: z.string().max(20_000).optional(),
  // The kind and unit pick one metric when a name is sent as several.
  metricKind: z.enum(["gauge", "sum", "histogram", "exponential_histogram", "summary"]).optional(),
  metricName: z.string().trim().max(200).optional(),
  metricUnit: z.string().max(100).optional(),
  showLegend: z.boolean().optional(),
  showXAxis: z.boolean().optional(),
  showYAxis: z.boolean().optional(),
  source: z.enum(["logs", "traces"]).optional(),
  unit: z.enum(widgetUnits).optional(),
});
export type DashboardWidgetConfig = z.infer<typeof dashboardWidgetConfigSchema>;

// Position on a 12-column grid.
export const dashboardWidgetLayoutSchema = z.object({
  h: z.number().int().min(1).max(100),
  w: z.number().int().min(1).max(12),
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0).max(100_000),
}).refine((layout) => layout.x + layout.w <= 12, { message: "Widget extends past the grid" });
export type DashboardWidgetLayout = z.infer<typeof dashboardWidgetLayoutSchema>;

const variableNamePattern = /^[a-zA-Z][a-zA-Z0-9_]*$/u;

const dashboardVariableSchema = z.object({
  // The attribute a variable filters on when added to a widget.
  attributeKey: z.string().trim().max(200).optional(),
  defaultValue: z.string().max(500).optional(),
  label: z.string().trim().max(120).optional(),
  // Several values can be selected at once. Selecting none matches every value.
  multi: z.boolean().optional(),
  name: z.string().max(60).regex(variableNamePattern, "Use letters, digits and underscores, starting with a letter"),
  // Empty means the value is typed freely.
  options: z.array(z.string().max(500)).max(200),
});
export type DashboardVariable = z.infer<typeof dashboardVariableSchema>;

export const dashboardVariablesSchema = z
  .array(dashboardVariableSchema)
  .max(50)
  .superRefine((variables, context) => {
    const names = new Set<string>();
    variables.forEach((variable, index) => {
      if (names.has(variable.name)) {
        context.addIssue({ code: "custom", message: `Duplicate variable ${variable.name}`, path: [index, "name"] });
      }
      names.add(variable.name);
      if (
        variable.defaultValue !== undefined &&
        variable.options.length > 0 &&
        !variable.options.includes(variable.defaultValue)
      ) {
        context.addIssue({ code: "custom", message: "The default must be one of the options", path: [index, "defaultValue"] });
      }
    });
  });

const dashboardNameSchema = z.string().trim().min(1).max(120);

export const dashboardCreateSchema = z.object({
  name: dashboardNameSchema,
  projectId: z.uuid(),
  variables: dashboardVariablesSchema.optional(),
});

export const dashboardUpdateSchema = z
  .object({ name: dashboardNameSchema.optional(), variables: dashboardVariablesSchema.optional() })
  .refine((update) => update.name !== undefined || update.variables !== undefined, { message: "Nothing to update" });

const widgetTitleSchema = z.string().trim().min(1).max(200);

export const dashboardWidgetCreateSchema = z
  .object({
    config: dashboardWidgetConfigSchema,
    layout: dashboardWidgetLayoutSchema.optional(),
    title: widgetTitleSchema,
    type: z.enum(dashboardWidgetTypes),
  })
  .superRefine((widget, context) => {
    const problem = widgetConfigProblem(widget.type, widget.config);
    if (problem) context.addIssue({ code: "custom", message: problem.message, path: ["config", problem.field] });
  });

// Why a chart widget's settings cannot be queried, or null when they can.
export function widgetConfigProblem(
  type: DashboardWidgetType,
  config: DashboardWidgetConfig,
): { field: keyof DashboardWidgetConfig; message: string } | null {
  const aggregation = config.aggregation;
  if (type === "timeseries_metric") {
    if (!config.metricName) return { field: "metricName", message: "Choose a metric" };
    if (aggregation && !(metricAggregations as readonly string[]).includes(aggregation)) {
      return { field: "aggregation", message: "Metrics are summed, averaged, or read as a minimum, maximum or percentile" };
    }
  }
  if (type === "timeseries_count" && aggregation && aggregation !== "count" && !config.field) {
    return { field: "field", message: "Choose a field to aggregate" };
  }
  return null;
}

export const dashboardWidgetUpdateSchema = z
  .object({
    config: dashboardWidgetConfigSchema.optional(),
    layout: dashboardWidgetLayoutSchema.optional(),
    title: widgetTitleSchema.optional(),
  })
  .refine((update) => Object.values(update).some((value) => value !== undefined), { message: "Nothing to update" });

export const dashboardLayoutUpdateSchema = z.object({
  widgets: z.array(z.object({ id: z.uuid(), layout: dashboardWidgetLayoutSchema })).min(1).max(200),
});

// The standard size per type. y = 100000 places the widget below the others;
// the grid moves it up into the first free row.
export function defaultWidgetLayout(type: DashboardWidgetType): DashboardWidgetLayout {
  switch (type) {
    case "markdown":
      return { h: 5, w: 4, x: 0, y: 100_000 };
    case "log_table":
    case "trace_table":
      return { h: 6, w: 12, x: 0, y: 100_000 };
    case "timeseries_count":
    case "timeseries_metric":
      return { h: 4, w: 6, x: 0, y: 100_000 };
  }
}

// A `${name}` or bare `$name` reference to a dashboard variable.
const variableReference = /\$\{(\w+)\}|\$(\w+)/gu;
const wholeReference = /^(?:\$\{(\w+)\}|\$(\w+))$/u;

// A selected variable value: one value, or several for a multi-value variable.
export type DashboardVariableValue = string | string[];

// A filter after variables are filled in. `values` holds the selection of a
// multi-value variable, which matches any of them.
export type ResolvedWidgetFilter = DashboardWidgetFilter & { values?: string[] };

// Replaces variable references in each filter value with the selected value.
// An unknown reference stays as written, so it is visible rather than blank.
// A filter whose whole value is a multi-value variable matches any selected
// value, and is dropped when none is selected.
export function resolveWidgetFilters(
  filters: DashboardWidgetFilter[] | undefined,
  values: Record<string, DashboardVariableValue>,
): ResolvedWidgetFilter[] {
  return (filters ?? []).flatMap((filter): ResolvedWidgetFilter[] => {
    const whole = wholeReference.exec(filter.value);
    const name = whole ? (whole[1] ?? whole[2] ?? "") : "";
    if (whole && Object.hasOwn(values, name) && Array.isArray(values[name])) {
      const selected = values[name];
      if (selected.length === 0) return [];
      return selected.length === 1 ? [{ ...filter, value: selected[0]! }] : [{ ...filter, value: selected[0]!, values: selected }];
    }
    return [{
      ...filter,
      value: filter.value.replace(variableReference, (reference, braced?: string, bare?: string) => {
        const key = braced ?? bare ?? "";
        if (!Object.hasOwn(values, key)) return reference;
        const selected = values[key]!;
        return Array.isArray(selected) ? selected.join(",") : selected;
      }),
    }];
  });
}

export const defaultSeriesLimit = 10;
// Grids beyond this mean mismatched inputs; the series are left unfilled.
const maximumBuckets = 2_000;

export interface ChartSeries {
  // True for the series that sums every group past the limit.
  other: boolean;
  name: string;
  // One value per bucket. Null where a metric has no data point.
  values: Array<number | null>;
}

export interface ChartData {
  // Bucket start times in milliseconds since the epoch.
  buckets: number[];
  series: ChartSeries[];
  stepMs: number;
}

// ClickHouse returns UTC buckets such as "2026-10-13 15:05:00".
function bucketTime(bucket: string): number {
  return new Date(`${bucket.replace(" ", "T")}Z`).getTime();
}

// Groups rows into at most `limit` series by total, plus one "Other" series
// for the rest. Every bucket in the window is on the axis. Counts fill missing
// buckets with zero; metrics leave them null. Values that do not add up, such
// as averages and percentiles, get no "Other" series.
export function chartSeries(
  rows: Array<{ bucket: string; group: string; value: number }>,
  options: { fill: "null" | "zero"; limit?: number; other?: boolean; sinceMs: number; stepMs: number; untilMs: number },
): ChartData {
  const { sinceMs, stepMs, untilMs } = options;
  const limit = options.limit ?? defaultSeriesLimit;
  const times = new Set<number>();
  if (stepMs > 0 && untilMs >= sinceMs && (untilMs - sinceMs) / stepMs <= maximumBuckets) {
    for (let time = Math.floor(sinceMs / stepMs) * stepMs; time <= untilMs; time += stepMs) times.add(time);
  }
  const totals = new Map<string, number>();
  for (const row of rows) {
    const time = bucketTime(row.bucket);
    if (Number.isNaN(time)) continue;
    times.add(time);
    const name = row.group || "(none)";
    totals.set(name, (totals.get(name) ?? 0) + Math.abs(row.value));
  }
  const buckets = [...times].sort((a, b) => a - b);
  const index = new Map(buckets.map((time, position) => [time, position]));
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
  const kept = new Set(ranked.slice(0, limit));
  const empty = () => new Array<number | null>(buckets.length).fill(options.fill === "zero" ? 0 : null);
  const values = new Map([...kept].map((name) => [name, empty()]));
  const rest = ranked.length > kept.size && options.other !== false ? empty() : null;
  for (const row of rows) {
    const position = index.get(bucketTime(row.bucket));
    if (position === undefined) continue;
    const target = values.get(row.group || "(none)") ?? rest;
    if (target) target[position] = (target[position] ?? 0) + row.value;
  }
  const series: ChartSeries[] = ranked
    .filter((name) => kept.has(name))
    .map((name) => ({ name, other: false, values: values.get(name)! }));
  if (rest) {
    // Keep the name distinct from a real group called "Other".
    let name = "Other";
    for (let suffix = 2; kept.has(name); suffix += 1) name = `Other (${suffix})`;
    series.push({ name, other: true, values: rest });
  }
  return { buckets, series, stepMs };
}
