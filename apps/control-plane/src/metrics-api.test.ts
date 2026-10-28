import { describe, expect, it } from "vitest";
import {
  dimensionLabel,
  filterMetricCatalog,
  groupMetricCatalog,
  groupMetrics,
  metricAggregationOptions,
  metricAlertDraft,
  metricChartTitle,
  metricDisplay,
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
    servicesComplete: true,
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
  range: { kind: "relative", minutes: 360 },
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

  it("groups CloudWatch metrics by AWS service after the application's own", () => {
    const groups = groupMetrics([
      metric("amazonaws.com/AWS/SQS/NumberOfMessagesSent", { kind: "summary" }),
      metric("http.server.request.duration"),
      metric("amazonaws.com/AWS/EC2/NetworkIn", { kind: "summary" }),
      metric("amazonaws.com/AWS/EC2/CPUUtilization", { kind: "summary" }),
    ]);

    expect(groups.map((group) => [group.namespace, group.metrics.map((entry) => metricDisplay(entry).title)])).toEqual([
      ["http", ["http.server.request.duration"]],
      ["AWS EC2", ["CPU utilization", "Network bytes in"]],
      ["AWS SQS", ["Messages sent"]],
    ]);
  });

  it("groups catalog rows only when CloudWatch metrics are present", () => {
    const own = [metric("uptime"), metric("http.server.request.duration")];
    expect(groupMetricCatalog(own)).toEqual({ grouped: false, rows: own });

    const rows = groupMetricCatalog([
      metric("amazonaws.com/AWS/RDS/FreeStorageSpace"),
      metric("uptime"),
      metric("amazonaws.com/AWS/EC2/CPUUtilization"),
      metric("http.server.request.duration"),
    ]).rows.map((entry) => entry.name);
    expect(rows).toEqual([
      "uptime",
      "http.server.request.duration",
      "amazonaws.com/AWS/EC2/CPUUtilization",
      "amazonaws.com/AWS/RDS/FreeStorageSpace",
    ]);
  });

  it("titles CloudWatch metrics and keeps a description that was sent", () => {
    expect(metricDisplay(metric("amazonaws.com/AWS/SQS/ApproximateAgeOfOldestMessage"))).toEqual({
      description: "Seconds the oldest message has waited in the queue.",
      title: "Oldest message age",
    });
    expect(metricDisplay(metric("amazonaws.com/AWS/SQS/ApproximateAgeOfOldestMessage", { description: "Sent" })).description)
      .toBe("Sent");
    expect(metricDisplay(metric("uptime", { description: "Seconds up" }))).toEqual({ description: "Seconds up", title: "uptime" });
    expect(metricChartTitle({ ...query, groupBy: "", name: "amazonaws.com/AWS/Lambda/Duration" }))
      .toBe("95th percentile of Lambda duration");
  });

  it("finds CloudWatch metrics by their readable title", () => {
    const metrics = [metric("amazonaws.com/AWS/SQS/ApproximateNumberOfMessagesVisible"), metric("queue.depth")];
    expect(searchMetrics(metrics, "messages waiting").map((entry) => entry.name))
      .toEqual(["amazonaws.com/AWS/SQS/ApproximateNumberOfMessagesVisible"]);
    expect(searchMetrics(metrics, "sqs").map((entry) => entry.name))
      .toEqual(["amazonaws.com/AWS/SQS/ApproximateNumberOfMessagesVisible"]);
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

  it("keeps metrics with sampled services under a service filter", () => {
    const metrics = [
      metric("checkout.orders", { services: ["checkout-api"] }),
      metric("inventory.stock", { services: ["inventory"] }),
      metric("queue.depth", { kind: "sum", services: ["worker"], servicesComplete: false }),
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
    const href = metricExplorerHref({ kind: "histogram", name: "rpc.duration", unit: "ms" }, { range: { kind: "relative", minutes: 60 } });

    expect(href).toBe("/metrics/explore?kind=histogram&metric=rpc.duration&unit=ms");
    expect(metricQueryFromParams(new URL(href, "https://app.test").searchParams)?.aggregation).toBe("p95");
    expect(metricQueryFromParams(new URLSearchParams("kind=histogram&metric=a&aggregation="))?.aggregation).toBe("");
  });

  it("names a metric by its name, kind and unit, including an empty unit", () => {
    const href = metricExplorerHref({ kind: "sum", name: "jobs", unit: "" }, { range: { kind: "relative", minutes: 60 } });
    const parsed = metricQueryFromParams(new URL(href, "https://app.test").searchParams);

    expect(parsed).toMatchObject({ kind: "sum", name: "jobs", unit: "" });
    expect(metricQueryFromParams(new URLSearchParams("kind=sum&metric=jobs"))?.unit).toBeNull();
  });

  it("ignores unknown kinds, ranges and aggregations", () => {
    expect(metricQueryFromParams(new URLSearchParams("kind=counter&metric=a"))).toBeNull();
    expect(metricQueryFromParams(new URLSearchParams("kind=gauge&metric=a&range=90d&aggregation=median"))).toMatchObject({
      aggregation: "",
      range: { kind: "relative", minutes: 60 },
    });
  });

  it("keeps a fixed window in the URL", () => {
    const fixed = { ...query, range: { from: Date.UTC(2026, 9, 28, 9), kind: "absolute" as const, to: Date.UTC(2026, 9, 28, 10) } };
    const params = metricQueryParams(fixed);

    expect(params.get("from")).toBe("2026-10-28T09:00:00.000Z");
    expect(params.get("to")).toBe("2026-10-28T10:00:00.000Z");
    expect(params.has("range")).toBe(false);
    expect(metricQueryFromParams(params)?.range).toEqual(fixed.range);
    expect(metricQueryParams({ ...query, range: { kind: "relative", minutes: 60 } }).has("range")).toBe(false);
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
