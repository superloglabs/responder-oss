import { describe, expect, it } from "vitest";
import {
  chartSeries,
  dashboardVariablesSchema,
  dashboardWidgetConfigSchema,
  dashboardWidgetCreateSchema,
  dashboardWidgetLayoutSchema,
  defaultWidgetLayout,
  resolveWidgetFilters,
  widgetConfigProblem,
} from "./dashboards.js";

const minute = 60_000;
const start = Date.parse("2026-10-13T12:00:00.000Z");

describe("dashboard widgets", () => {
  it("accepts a Superlog widget config as stored", () => {
    const config = {
      aggregation: "p95",
      chartType: "line",
      filter: { resourceAttrs: [{ key: "service.name", op: "neq", value: "$service" }] },
      groupBy: "attr:http.route",
      legendPosition: "bottom",
      limit: 5,
      metricName: "http.server.duration",
      showLegend: true,
      unit: "duration_ms",
    };
    expect(dashboardWidgetConfigSchema.parse(config)).toEqual(config);
  });

  it("rejects home page widgets and layouts past the grid", () => {
    expect(
      dashboardWidgetCreateSchema.safeParse({ config: {}, title: "Incidents", type: "active_incidents" }).success,
    ).toBe(false);
    expect(dashboardWidgetLayoutSchema.safeParse({ h: 4, w: 6, x: 8, y: 0 }).success).toBe(false);
    expect(dashboardWidgetLayoutSchema.safeParse({ h: 4, w: 6, x: 6, y: 0 }).success).toBe(true);
  });

  it("needs a metric name for a metric chart", () => {
    expect(dashboardWidgetCreateSchema.safeParse({ config: {}, title: "Latency", type: "timeseries_metric" }).success).toBe(
      false,
    );
    expect(
      dashboardWidgetCreateSchema.safeParse({ config: { metricName: " " }, title: "Latency", type: "timeseries_metric" })
        .success,
    ).toBe(false);
    expect(
      dashboardWidgetCreateSchema.safeParse({
        config: { metricName: "http.server.duration" },
        title: "Latency",
        type: "timeseries_metric",
      }).success,
    ).toBe(true);
  });

  it("needs a field to aggregate logs or spans other than by counting", () => {
    expect(widgetConfigProblem("timeseries_count", { filter: {} })).toBeNull();
    expect(widgetConfigProblem("timeseries_count", { aggregation: "count", filter: {} })).toBeNull();
    expect(widgetConfigProblem("timeseries_count", { aggregation: "p95", filter: {} })).toEqual({
      field: "field",
      message: "Choose a field to aggregate",
    });
    expect(widgetConfigProblem("timeseries_count", { aggregation: "p95", field: "duration", filter: {} })).toBeNull();
    expect(
      dashboardWidgetCreateSchema.safeParse({
        config: { aggregation: "sum", display: "number", field: "span.gen_ai.usage.output_tokens", source: "traces" },
        title: "Output tokens",
        type: "timeseries_count",
      }).success,
    ).toBe(true);
  });

  it("aggregates metrics only in the ways a metric supports", () => {
    expect(widgetConfigProblem("timeseries_metric", { aggregation: "count", filter: {}, metricName: "queue.depth" })?.field).toBe(
      "aggregation",
    );
    expect(widgetConfigProblem("timeseries_metric", { aggregation: "p50", filter: {}, metricName: "queue.depth" })?.field).toBe(
      "aggregation",
    );
    expect(widgetConfigProblem("timeseries_metric", { aggregation: "p99", filter: {}, metricName: "queue.depth" })).toBeNull();
  });

  it("sizes new widgets by type and places them last", () => {
    expect(defaultWidgetLayout("timeseries_count")).toEqual({ h: 4, w: 6, x: 0, y: 100_000 });
    expect(defaultWidgetLayout("log_table").w).toBe(12);
  });
});

describe("dashboard variables", () => {
  it("rejects duplicate names and a default outside the options", () => {
    expect(
      dashboardVariablesSchema.safeParse([
        { name: "env", options: [] },
        { name: "env", options: [] },
      ]).success,
    ).toBe(false);
    expect(dashboardVariablesSchema.safeParse([{ defaultValue: "dev", name: "env", options: ["prod"] }]).success).toBe(
      false,
    );
    expect(dashboardVariablesSchema.safeParse([{ defaultValue: "any", name: "env", options: [] }]).success).toBe(true);
    expect(dashboardVariablesSchema.safeParse([{ name: "1env", options: [] }]).success).toBe(false);
  });

  it("substitutes references in filter values and keeps unknown ones", () => {
    expect(
      resolveWidgetFilters(
        [
          { key: "deployment.environment", value: "$env" },
          { key: "service.name", op: "neq", value: "${service}-worker" },
          { key: "region", value: "$region" },
        ],
        { env: "production", service: "api" },
      ),
    ).toEqual([
      { key: "deployment.environment", value: "production" },
      { key: "service.name", op: "neq", value: "api-worker" },
      { key: "region", value: "$region" },
    ]);
    expect(resolveWidgetFilters(undefined, {})).toEqual([]);
  });

  it("matches any selected value of a multi-value variable, and every value when none is selected", () => {
    const filters = [
      { key: "http.route", value: "$route" },
      { key: "region", op: "neq" as const, value: "${region}" },
      { key: "env", value: "$env" },
    ];
    expect(resolveWidgetFilters(filters, { env: [], region: ["eu-west-3"], route: ["POST /checkout", "POST /refunds"] })).toEqual([
      { key: "http.route", value: "POST /checkout", values: ["POST /checkout", "POST /refunds"] },
      { key: "region", op: "neq", value: "eu-west-3" },
    ]);
    // Inside a longer value the selection is joined.
    expect(resolveWidgetFilters([{ key: "k", value: "$route-x" }], { route: ["a", "b"] })).toEqual([{ key: "k", value: "a,b-x" }]);
  });

  it("ignores inherited object properties as variable names", () => {
    expect(resolveWidgetFilters([{ key: "k", value: "$constructor" }], {})).toEqual([
      { key: "k", value: "$constructor" },
    ]);
  });
});

describe("chartSeries", () => {
  const window = { sinceMs: start, stepMs: minute, untilMs: start + 3 * minute };

  it("puts every bucket in the window on the axis and fills counts with zero", () => {
    const data = chartSeries([{ bucket: "2026-10-13 12:01:00", group: "", value: 4 }], { ...window, fill: "zero" });
    expect(data.buckets).toEqual([start, start + minute, start + 2 * minute, start + 3 * minute]);
    expect(data.series).toEqual([{ name: "(none)", other: false, values: [0, 4, 0, 0] }]);
  });

  it("leaves metric gaps empty", () => {
    const data = chartSeries([{ bucket: "2026-10-13 12:02:00", group: "api", value: 1.5 }], { ...window, fill: "null" });
    expect(data.series[0]!.values).toEqual([null, null, 1.5, null]);
  });

  it("keeps the largest groups and sums the rest into Other", () => {
    const data = chartSeries(
      [
        { bucket: "2026-10-13 12:00:00", group: "a", value: 1 },
        { bucket: "2026-10-13 12:00:00", group: "b", value: 10 },
        { bucket: "2026-10-13 12:01:00", group: "Other", value: 5 },
        { bucket: "2026-10-13 12:01:00", group: "c", value: 2 },
      ],
      { ...window, fill: "zero", limit: 2 },
    );
    expect(data.series.map((series) => [series.name, series.other])).toEqual([
      ["b", false],
      ["Other", false],
      ["Other (2)", true],
    ]);
    expect(data.series[2]!.values).toEqual([1, 2, 0, 0]);
  });

  it("leaves out Other for values that do not add up", () => {
    const data = chartSeries(
      [
        { bucket: "2026-10-13 12:00:00", group: "a", value: 1 },
        { bucket: "2026-10-13 12:00:00", group: "b", value: 10 },
      ],
      { ...window, fill: "null", limit: 1, other: false },
    );
    expect(data.series.map((series) => series.name)).toEqual(["b"]);
  });

  it("skips the window fill when the step does not fit it", () => {
    const data = chartSeries([{ bucket: "2026-10-13 12:00:00", group: "a", value: 1 }], {
      fill: "zero",
      sinceMs: start,
      stepMs: 1,
      untilMs: start + 7 * 24 * 60 * minute,
    });
    expect(data.buckets).toEqual([start]);
  });
});
