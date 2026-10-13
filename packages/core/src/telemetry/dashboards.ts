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

export const metricAggregations = ["sum", "avg", "min", "max", "p95", "p99"] as const;
export const widgetUnits = ["none", "duration_ms", "duration_s", "bytes", "percent"] as const;
export type WidgetUnit = (typeof widgetUnits)[number];

export const dashboardWidgetConfigSchema = z.object({
  aggregation: z.enum(metricAggregations).optional(),
  chartType: z.enum(["line", "bar"]).optional(),
  description: z.string().max(500).optional(),
  filter: z.object({ resourceAttrs: z.array(widgetFilterSchema).max(50).optional() }).default({}),
  groupBy: z.string().trim().max(200).optional(),
  legendPosition: z.enum(["side", "bottom"]).optional(),
  // Series kept before the rest roll into "Other", or rows in a table.
  limit: z.number().int().positive().max(500).optional(),
  markdown: z.string().max(20_000).optional(),
  metricName: z.string().trim().max(200).optional(),
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

export const dashboardWidgetCreateSchema = z.object({
  config: dashboardWidgetConfigSchema,
  layout: dashboardWidgetLayoutSchema.optional(),
  title: widgetTitleSchema,
  type: z.enum(dashboardWidgetTypes),
});

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

// Replaces variable references in each filter value with the selected value.
// An unknown reference stays as written, so it is visible rather than blank.
export function resolveWidgetFilters(
  filters: DashboardWidgetFilter[] | undefined,
  values: Record<string, string>,
): DashboardWidgetFilter[] {
  return (filters ?? []).map((filter) => ({
    ...filter,
    value: filter.value.replace(variableReference, (reference, braced?: string, bare?: string) => {
      const name = braced ?? bare ?? "";
      return Object.hasOwn(values, name) ? values[name]! : reference;
    }),
  }));
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
// buckets with zero; metrics leave them null.
export function chartSeries(
  rows: Array<{ bucket: string; group: string; value: number }>,
  options: { fill: "null" | "zero"; limit?: number; sinceMs: number; stepMs: number; untilMs: number },
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
  const rest = ranked.length > kept.size ? empty() : null;
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
