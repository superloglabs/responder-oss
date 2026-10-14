import { describe, expect, it } from "vitest";
import {
  dimensionLabel,
  filterMetricCatalog,
  groupMetrics,
  metricAggregationOptions,
  metricAlertDraft,
  metricExplorerHref,
  metricQueryFromParams,
  metricQueryParams,
  metricWidgetDraft,
  metricWidgetUnit,
  searchMetrics,
  seriesStats,
  type MetricCatalogEntry,
  type MetricQuery,
} from "./metrics-api";

function metric(name: string, overrides: Partial<MetricCatalogEntry> = {}): MetricCatalogEntry {
  return {
    attributes: [],
    description: "",
    kind: "gauge",
    name,
    series: 1,
    services: ["checkout-api"],
    unit: "",
    ...overrides,
  };
}

const query: MetricQuery = {
  aggregation: "p95",
  chartType: "line",
  filters: [{ key: "resource.service.name", value: "checkout-api" }],
  groupBy: "attr:http.route",
  kind: "histogram",
  name: "http.server.request.duration",
  projectId: "b925b1df-5b78-43c8-a816-6f00afb174af",
  range: "6h",
  unit: "s",
};

describe("metric aggregations", () => {
  it("offers every aggregation except quantiles and extremes for summaries", () => {
    expect(metricAggregationOptions("histogram").map((option) => option.value)).toEqual([
      "", "sum", "avg", "min", "max", "p95", "p99",
    ]);
    expect(metricAggregationOptions("summary").map((option) => option.value)).toEqual(["sum", "avg"]);
    expect(metricAggregationOptions("histogram")[0]!.label).toBe("Count");
    expect(metricAggregationOptions("gauge")[0]!.label).toBe("Average");
  });

  it("opens a summary on the average of its observations", () => {
    const summary = new URLSearchParams({ kind: "summary", metric: "rpc.duration" });
    expect(metricQueryFromParams(summary)?.aggregation).toBe("avg");
    summary.set("aggregation", "median");
    expect(metricQueryFromParams(summary)?.aggregation).toBe("avg");
  });

  it("reads values in the metric's unit, except a histogram's point count", () => {
    expect(metricWidgetUnit({ kind: "histogram", unit: "s" }, "p95")).toBe("duration_s");
    expect(metricWidgetUnit({ kind: "histogram", unit: "s" }, "")).toBe("none");
    expect(metricWidgetUnit({ kind: "gauge", unit: "By" }, "")).toBe("bytes");
    expect(metricWidgetUnit({ kind: "sum", unit: "{request}" }, "sum")).toBe("none");
  });
});

describe("the metric catalog", () => {
  it("groups metrics by the first part of their name", () => {
    const groups = groupMetrics([
      metric("http.server.request.duration"),
      metric("db.client.connection.count"),
      metric("http.client.request.duration"),
      metric("uptime"),
    ]);

    expect(groups.map((group) => [group.namespace, group.metrics.map((entry) => entry.name)])).toEqual([
      ["db", ["db.client.connection.count"]],
      ["http", ["http.client.request.duration", "http.server.request.duration"]],
      ["uptime", ["uptime"]],
    ]);
  });

  it("searches names, descriptions, units and attribute keys", () => {
    const metrics = [
      metric("http.server.request.duration", { attributes: ["http.route"], description: "Duration of requests", unit: "s" }),
      metric("process.memory.usage", { description: "Resident memory", unit: "By" }),
    ];

    expect(searchMetrics(metrics, "route").map((entry) => entry.name)).toEqual(["http.server.request.duration"]);
    expect(searchMetrics(metrics, "resident MEMORY").map((entry) => entry.name)).toEqual(["process.memory.usage"]);
    expect(searchMetrics(metrics, "  ")).toHaveLength(2);
  });

  it("keeps metrics without read details under a service filter", () => {
    const metrics = [
      metric("checkout.orders", { services: ["checkout-api"] }),
      metric("inventory.stock", { services: ["inventory"] }),
      metric("queue.depth", { kind: "sum", series: null, services: [] }),
    ];

    expect(filterMetricCatalog(metrics, { kind: "", search: "", service: "checkout-api" }).map((entry) => entry.name))
      .toEqual(["checkout.orders", "queue.depth"]);
    expect(filterMetricCatalog(metrics, { kind: "gauge", search: "", service: "" }).map((entry) => entry.name))
      .toEqual(["checkout.orders", "inventory.stock"]);
    expect(filterMetricCatalog(metrics, { kind: "", search: "stock", service: "" }).map((entry) => entry.name))
      .toEqual(["inventory.stock"]);
  });

  it("names dimensions by their attribute key", () => {
    expect(dimensionLabel("attr:http.route")).toBe("http.route");
    expect(dimensionLabel("resource.service.name")).toBe("service.name");
    expect(dimensionLabel("service")).toBe("service");
  });
});

describe("series statistics", () => {
  it("averages, maximises and reads the last value over the points present", () => {
    expect(seriesStats([null, 2, 4, null, 6, null])).toEqual({ average: 4, last: 6, maximum: 6 });
    expect(seriesStats([null, null])).toEqual({ average: null, last: null, maximum: null });
  });
});

describe("explorer URLs", () => {
  it("round-trips a query, keeping filter values that contain equals signs", () => {
    const withEquals = { ...query, chartType: "bar" as const, filters: [{ key: "attr:query", value: "a=b" }] };

    expect(metricQueryFromParams(metricQueryParams(withEquals))).toEqual(withEquals);
  });

  it("opens a histogram on p95 and keeps defaults out of the URL", () => {
    const href = metricExplorerHref({ kind: "histogram", name: "rpc.duration", unit: "ms" }, { projectId: "p", range: "1h" });

    expect(href).toBe("/metrics/explore?kind=histogram&metric=rpc.duration&unit=ms&projectId=p");
    expect(metricQueryFromParams(new URL(href, "https://app.test").searchParams)?.aggregation).toBe("p95");
    expect(metricQueryFromParams(new URLSearchParams("kind=histogram&metric=a&aggregation="))?.aggregation).toBe("");
  });

  it("names a metric by its name, kind and unit, including an empty unit", () => {
    const href = metricExplorerHref({ kind: "sum", name: "jobs", unit: "" }, { projectId: "p", range: "1h" });
    const parsed = metricQueryFromParams(new URL(href, "https://app.test").searchParams);

    expect(parsed).toMatchObject({ kind: "sum", name: "jobs", unit: "" });
    expect(metricQueryFromParams(new URLSearchParams("kind=sum&metric=jobs"))?.unit).toBeNull();
  });

  it("ignores unknown kinds, ranges and aggregations", () => {
    expect(metricQueryFromParams(new URLSearchParams("kind=counter&metric=a"))).toBeNull();
    expect(metricQueryFromParams(new URLSearchParams("kind=gauge&metric=a&range=90d&aggregation=median"))).toMatchObject({
      aggregation: "",
      range: "1h",
    });
  });
});

describe("saving a graph", () => {
  it("becomes a metric widget with the same query", () => {
    expect(metricWidgetDraft(query, "s")).toEqual({
      config: {
        aggregation: "p95",
        chartType: "line",
        filter: { resourceAttrs: [{ key: "resource.service.name", value: "checkout-api" }] },
        groupBy: "attr:http.route",
        metricKind: "histogram",
        metricName: "http.server.request.duration",
        metricUnit: "s",
        unit: "duration_s",
      },
      title: "95th percentile of http.server.request.duration by http.route",
      type: "timeseries_metric",
    });
  });

  it("becomes a per-group metric alert on the average", () => {
    expect(metricAlertDraft(query)).toMatchObject({
      aggregation: "avg",
      groupBy: "attr:http.route",
      metricKind: "histogram",
      metricName: "http.server.request.duration",
      metricUnit: "s",
      perGroup: true,
      source: "metric",
    });
    expect(metricAlertDraft({ ...query, aggregation: "sum", groupBy: "" })).toMatchObject({
      aggregation: "sum",
      perGroup: false,
    });
    expect(metricAlertDraft({ ...query, aggregation: "", kind: "sum" }).aggregation).toBe("sum");
    expect(metricAlertDraft({ ...query, aggregation: "", kind: "gauge" }).aggregation).toBe("avg");
  });
});
