import {
  suggestedWidgetTitle,
  type DashboardWidgetConfig,
  type DashboardWidgetFilter,
  type DashboardWidgetType,
  type WidgetDraft,
  type WidgetUnit,
} from "./dashboards-api";

export type WidgetKind = "chart" | "note" | "table";
export type WidgetSource = "logs" | "metric" | "traces";

// The widget editor's form. While editing, fields that do not apply to the
// chosen kind are kept, so switching kinds back and forth loses nothing. A
// saved widget keeps only the settings its type uses.
export interface WidgetForm {
  aggregation: "" | NonNullable<DashboardWidgetConfig["aggregation"]>;
  chartType: "bar" | "line";
  filters: DashboardWidgetFilter[];
  groupBy: string;
  kind: WidgetKind;
  legendPosition: "bottom" | "side";
  // Series kept when grouped.
  limit: number;
  markdown: string;
  metricName: string;
  // Rows in a table.
  rows: number;
  showLegend: boolean;
  showXAxis: boolean;
  showYAxis: boolean;
  source: WidgetSource;
  title: string;
  unit: WidgetUnit;
}

// The most filters a widget can have.
export const maximumWidgetFilters = 50;

export const emptyWidgetForm: WidgetForm = {
  aggregation: "",
  chartType: "bar",
  filters: [],
  groupBy: "",
  kind: "chart",
  legendPosition: "bottom",
  limit: 10,
  markdown: "",
  metricName: "",
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
    config = {
      chartType: form.chartType,
      filter,
      legendPosition: form.legendPosition,
      showLegend: form.showLegend,
      showXAxis: form.showXAxis,
      showYAxis: form.showYAxis,
      ...(form.groupBy ? { groupBy: form.groupBy, limit: form.limit } : {}),
      ...(form.unit === "none" ? {} : { unit: form.unit }),
      ...(type === "timeseries_count"
        ? { source: form.source === "traces" ? ("traces" as const) : ("logs" as const) }
        : { metricName: form.metricName, ...(form.aggregation ? { aggregation: form.aggregation } : {}) }),
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
    filters: config.filter.resourceAttrs ?? [],
    groupBy: config.groupBy ?? "",
    kind,
    legendPosition: config.legendPosition ?? "bottom",
    limit: kind === "chart" ? config.limit ?? 10 : 10,
    markdown: config.markdown ?? "",
    metricName: config.metricName ?? "",
    rows: kind === "table" ? config.limit ?? 50 : 50,
    showLegend: config.showLegend ?? true,
    showXAxis: config.showXAxis ?? true,
    showYAxis: config.showYAxis ?? true,
    source,
    title: widget.title,
    unit: config.unit ?? "none",
  };
}
