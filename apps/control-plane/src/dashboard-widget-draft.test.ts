import { describe, expect, it } from "vitest";
import { emptyWidgetForm, widgetDraft, widgetForm, widgetType } from "./dashboard-widget-draft";

describe("widgetType", () => {
  it("maps the editor's kind and source to a widget type", () => {
    expect(widgetType({ kind: "chart", source: "logs" })).toBe("timeseries_count");
    expect(widgetType({ kind: "chart", source: "metric" })).toBe("timeseries_metric");
    expect(widgetType({ kind: "table", source: "traces" })).toBe("trace_table");
    expect(widgetType({ kind: "table", source: "metric" })).toBe("log_table");
    expect(widgetType({ kind: "note", source: "logs" })).toBe("markdown");
  });
});

describe("widgetDraft", () => {
  it("saves only the settings a count chart uses, with a suggested title", () => {
    expect(
      widgetDraft({
        ...emptyWidgetForm,
        filters: [{ key: "service.name", value: "api" }, { key: " ", value: "ignored" }],
        groupBy: "attr:http.route",
        markdown: "unused",
        metricName: "unused",
        source: "traces",
      }),
    ).toEqual({
      config: {
        chartType: "bar",
        filter: { resourceAttrs: [{ key: "service.name", value: "api" }] },
        groupBy: "attr:http.route",
        legendPosition: "bottom",
        limit: 10,
        showLegend: true,
        showXAxis: true,
        showYAxis: true,
        source: "traces",
      },
      title: "Spans by http.route",
      type: "timeseries_count",
    });
  });

  it("saves a metric chart with its aggregation and unit", () => {
    const draft = widgetDraft({
      ...emptyWidgetForm,
      aggregation: "p95",
      chartType: "line",
      metricName: "http.server.duration",
      source: "metric",
      title: "  Latency ",
      unit: "duration_ms",
    });
    expect(draft.title).toBe("Latency");
    expect(draft.config).toMatchObject({ aggregation: "p95", metricName: "http.server.duration", unit: "duration_ms" });
    expect(draft.config.source).toBeUndefined();
  });

  it("keeps a metric chart's kind and unit through an edit", () => {
    const saved = {
      config: { filter: {}, metricKind: "histogram" as const, metricName: "rpc.duration", metricUnit: "ms" },
      title: "RPC duration",
      type: "timeseries_metric" as const,
    };

    expect(widgetDraft(widgetForm(saved)).config).toMatchObject({ metricKind: "histogram", metricUnit: "ms" });
    const byName = widgetDraft({ ...emptyWidgetForm, kind: "chart", metricName: "rpc.duration", source: "metric" });
    expect(byName.config).not.toHaveProperty("metricKind");
    expect(byName.config).not.toHaveProperty("metricUnit");
  });

  it("caps table rows and saves notes", () => {
    expect(widgetDraft({ ...emptyWidgetForm, kind: "table", source: "logs" }).config).toEqual({ filter: {}, limit: 50 });
    expect(widgetDraft({ ...emptyWidgetForm, kind: "table", rows: 500, source: "traces" }).config).toEqual({
      filter: {},
      limit: 200,
    });
    expect(widgetDraft({ ...emptyWidgetForm, kind: "note", markdown: "# Runbook\nSteps" })).toEqual({
      config: { filter: {}, markdown: "# Runbook\nSteps" },
      title: "Runbook",
      type: "markdown",
    });
  });
});

describe("widgetForm", () => {
  it("round-trips a saved widget, keeping its axis settings", () => {
    const saved = {
      config: {
        aggregation: "max" as const,
        chartType: "bar" as const,
        filter: { resourceAttrs: [{ key: "env", value: "$env" }] },
        legendPosition: "side" as const,
        metricName: "queue.depth",
        showLegend: false,
        showXAxis: false,
        showYAxis: true,
      },
      title: "Queue depth",
      type: "timeseries_metric" as const,
    };
    expect(widgetDraft(widgetForm(saved))).toEqual(saved);
  });
});
