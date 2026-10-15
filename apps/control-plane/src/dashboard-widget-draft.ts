import {
  suggestedWidgetTitle,
  type DashboardWidgetConfig,
  type DashboardWidgetFilter,
  type DashboardWidgetType,
  type WidgetDisplay,
  type WidgetDraft,
  type WidgetUnit,
} from "./dashboards-api";
import type { MetricKind } from "./metrics-api";

export type WidgetKind = "chart" | "note" | "table";
export type WidgetSource = "logs" | "metric" | "traces";

// The widget editor's form. While editing, fields that do not apply to the
// chosen kind are kept, so switching kinds back and forth loses nothing. A
// saved widget keeps only the settings its type uses.
export interface WidgetForm {
  // Empty counts logs and spans, or takes a metric's default.
  aggregation: "" | NonNullable<DashboardWidgetConfig["aggregation"]>;
  chartType: "bar" | "line";
  compare: boolean;
  display: WidgetDisplay;
  // What a log or span aggregation reads.
  field: string;
  filters: DashboardWidgetFilter[];
  groupBy: string;
  kind: WidgetKind;
  legendPosition: "bottom" | "side";
  // Series kept when grouped.
  limit: number;
  markdown: string;
  // With the name, the one metric charted; empty and null read every kind
  // and unit of the name.
  metricKind: MetricKind | "";
  metricName: string;
  metricUnit: string | null;
  // Rows in a table.
  rows: number;
  showLegend: boolean;
  showXAxis: boolean;
  showYAxis: boolean;
  source: WidgetSource;
  title: string;
  unit: WidgetUnit;
}

export const emptyWidgetForm: WidgetForm = {
  aggregation: "",
  chartType: "bar",
  compare: false,
  display: "timeseries",
  field: "",
  filters: [],
  groupBy: "",
  kind: "chart",
  legendPosition: "bottom",
  limit: 10,
  markdown: "",
  metricKind: "",
  metricName: "",
  metricUnit: null,
  rows: 50,
  showLegend: true,
  showXAxis: true,
  showYAxis: true,
  source: "logs",
  title: "",
  unit: "none",
};

export function widgetType(form: Pick<WidgetForm, "kind" | "source">): DashboardWidgetType {
  if (form.kind === "note") return "markdown";
  if (form.kind === "table") return form.source === "traces" ? "trace_table" : "log_table";
  return form.source === "metric" ? "timeseries_metric" : "timeseries_count";
}

const metricAggregations = new Set(["sum", "avg", "min", "max", "p95", "p99"]);

// The saved widget for a form: only the settings its type uses, and the
// suggested title when none is typed.
export function widgetDraft(form: WidgetForm): WidgetDraft {
  const type = widgetType(form);
  const filters = form.filters.filter((filter) => filter.key.trim());
  const filter = filters.length > 0 ? { resourceAttrs: filters } : {};
  let config: DashboardWidgetConfig;
  if (type === "markdown") {
    config = { filter: {}, markdown: form.markdown };
  } else if (type === "log_table" || type === "trace_table") {
    config = { filter, limit: Math.min(form.rows, type === "trace_table" ? 200 : 500) };
  } else {
    const overTime = form.display === "timeseries";
    const grouped = form.display !== "number" && Boolean(form.groupBy);
    const aggregation =
      type === "timeseries_count"
        ? form.aggregation && form.aggregation !== "count" && form.field
          ? { aggregation: form.aggregation, field: form.field }
          : {}
        : form.aggregation && metricAggregations.has(form.aggregation)
          ? { aggregation: form.aggregation }
          : {};
    config = {
      filter,
      ...(overTime
        ? {
            chartType: form.chartType,
            legendPosition: form.legendPosition,
            showLegend: form.showLegend,
            showXAxis: form.showXAxis,
            showYAxis: form.showYAxis,
          }
        : { display: form.display, ...(form.compare ? { compare: "previous_period" as const } : {}) }),
      ...(grouped ? { groupBy: form.groupBy, limit: form.limit } : {}),
      ...(form.unit === "none" ? {} : { unit: form.unit }),
      ...(type === "timeseries_count"
        ? { source: form.source === "traces" ? ("traces" as const) : ("logs" as const), ...aggregation }
        : {
            metricName: form.metricName,
            ...(form.metricKind ? { metricKind: form.metricKind } : {}),
            ...(form.metricUnit !== null ? { metricUnit: form.metricUnit } : {}),
            ...aggregation,
          }),
    };
  }
  return { config, title: form.title.trim() || suggestedWidgetTitle({ config, type }), type };
}

// The form for an existing widget.
export function widgetForm(widget: WidgetDraft): WidgetForm {
  const { config, type } = widget;
  const kind: WidgetKind = type === "markdown" ? "note" : type === "log_table" || type === "trace_table" ? "table" : "chart";
  const source: WidgetSource =
    type === "timeseries_metric" ? "metric" : type === "trace_table" || config.source === "traces" ? "traces" : "logs";
  return {
    aggregation: config.aggregation ?? "",
    chartType: config.chartType ?? (type === "timeseries_metric" ? "line" : "bar"),
    compare: config.compare === "previous_period",
    display: config.display ?? "timeseries",
    field: config.field ?? "",
    filters: config.filter.resourceAttrs ?? [],
    groupBy: config.groupBy ?? "",
    kind,
    legendPosition: config.legendPosition ?? "bottom",
    limit: kind === "chart" ? config.limit ?? 10 : 10,
    markdown: config.markdown ?? "",
    metricKind: config.metricKind ?? "",
    metricName: config.metricName ?? "",
    metricUnit: config.metricUnit ?? null,
    rows: kind === "table" ? config.limit ?? 50 : 50,
    showLegend: config.showLegend ?? true,
    showXAxis: config.showXAxis ?? true,
    showYAxis: config.showYAxis ?? true,
    source,
    title: widget.title,
    unit: config.unit ?? "none",
  };
}
