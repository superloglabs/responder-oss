import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { listMetricCatalog, listMetricDimensions, metricSeries } from "./query.js";

const clickhouseUrl = process.env.CLICKHOUSE_URL;
const database = `metric_catalog_${randomUUID().replaceAll("-", "")}`;
const range = { since: "2026-01-01T00:00:00Z", until: "2026-01-01T01:00:00Z" };
let admin: ClickHouseClient;
let ch: ClickHouseClient;

const scopeColumns = `
  ResourceAttributes Map(String, String),
  ResourceSchemaUrl String,
  ScopeName String,
  ScopeVersion String,
  ScopeAttributes Map(String, String),
  ScopeSchemaUrl String,
  ServiceName String,`;

const scalarColumns = `${scopeColumns}
  MetricName String,
  MetricUnit String,
  Attributes Map(String, String),
  StartTimeUnix DateTime64(9),
  TimeUnix DateTime64(9),
  Value Float64,
  AggregationTemporality Int32,
  IsMonotonic Bool
`;

const histogramColumns = `${scopeColumns}
  MetricName String,
  MetricUnit String,
  Attributes Map(String, String),
  StartTimeUnix DateTime64(9),
  TimeUnix DateTime64(9),
  Count UInt64,
  Sum Float64,
  Min Float64,
  Max Float64,
  BucketCounts Array(UInt64),
  ExplicitBounds Array(Float64),
  AggregationTemporality Int32
`;

function resource(service: string, extra: Record<string, string> = {}, projectId = "project-1") {
  return { "service.name": service, "superlog.project_id": projectId, ...extra };
}

beforeAll(async () => {
  if (!clickhouseUrl) return;
  admin = createClient({ url: clickhouseUrl });
  await admin.command({ query: `CREATE DATABASE ${database}` });
  ch = createClient({ url: clickhouseUrl, database });
  // Gauges carry descriptions; this histogram table is from a collector that
  // predates them.
  await ch.command({
    query: `CREATE TABLE otel_metrics_gauge (${scalarColumns}, MetricDescription String) ENGINE = MergeTree ORDER BY (MetricName, TimeUnix)`,
  });
  await ch.command({
    query: `CREATE TABLE otel_metrics_sum (${scalarColumns}, MetricDescription String) ENGINE = MergeTree ORDER BY (MetricName, TimeUnix)`,
  });
  await ch.command({
    query: `CREATE TABLE otel_metrics_histogram (${histogramColumns}) ENGINE = MergeTree ORDER BY (MetricName, TimeUnix)`,
  });

  const gaugePoint = (time: string, service: string, attributes: Record<string, string>, value: number, extra: Record<string, string> = {}) => ({
    Attributes: attributes,
    MetricDescription: "Requests in flight",
    MetricName: "http.server.active_requests",
    MetricUnit: "{request}",
    ResourceAttributes: resource(service, extra),
    ServiceName: service,
    StartTimeUnix: time,
    TimeUnix: time,
    Value: value,
  });
  await ch.insert({
    format: "JSONEachRow",
    table: "otel_metrics_gauge",
    values: [
      gaugePoint("2026-01-01 00:10:00", "checkout-api", { "http.request.method": "GET" }, 3, { "host.name": "a" }),
      gaugePoint("2026-01-01 00:10:00", "checkout-api", { "http.request.method": "POST" }, 1, { "host.name": "a" }),
      gaugePoint("2026-01-01 00:11:00", "checkout-api", { "http.request.method": "GET" }, 4, { "host.name": "b" }),
      gaugePoint("2026-01-01 00:11:00", "inventory", { "http.request.method": "GET", "server.address": "db" }, 2),
      // Another project's point stays out of every result.
      {
        ...gaugePoint("2026-01-01 00:11:00", "elsewhere", { secret: "x" }, 9),
        ResourceAttributes: resource("elsewhere", {}, "project-2"),
      },
    ],
  });
  const histogramPoint = (time: string, route: string, count: number) => ({
    AggregationTemporality: 1,
    Attributes: { "http.route": route },
    BucketCounts: [count],
    Count: count,
    ExplicitBounds: [],
    Max: 1,
    Min: 0,
    MetricName: "http.server.request.duration",
    MetricUnit: "s",
    ResourceAttributes: resource("checkout-api"),
    ServiceName: "checkout-api",
    StartTimeUnix: time,
    Sum: count / 2,
    TimeUnix: time,
  });
  await ch.insert({
    format: "JSONEachRow",
    table: "otel_metrics_histogram",
    values: [
      histogramPoint("2026-01-01 00:20:00", "POST /checkout", 4),
      histogramPoint("2026-01-01 00:21:00", "POST /checkout", 6),
      histogramPoint("2026-01-01 00:21:00", "GET /cart/:id", 10),
    ],
  });
});

afterAll(async () => {
  if (!clickhouseUrl) return;
  await ch.close();
  await admin.command({ query: `DROP DATABASE ${database}` });
  await admin.close();
});

test("the catalog describes each metric in the project", { skip: !clickhouseUrl }, async () => {
  const catalog = await listMetricCatalog(ch, "project-1", range);

  assert.deepEqual(catalog, [
    {
      attributes: ["http.request.method", "server.address"],
      description: "Requests in flight",
      kind: "gauge",
      name: "http.server.active_requests",
      series: 4,
      services: ["checkout-api", "inventory"],
      servicesComplete: true,
      unit: "{request}",
    },
    {
      attributes: ["http.route"],
      description: "",
      kind: "histogram",
      name: "http.server.request.duration",
      series: 2,
      services: ["checkout-api"],
      servicesComplete: true,
      unit: "s",
    },
  ]);
});

test("dimensions list a metric's attributes with their values", { skip: !clickhouseUrl }, async () => {
  const dimensions = await listMetricDimensions(
    ch,
    "project-1",
    { kind: "gauge", name: "http.server.active_requests", unit: "{request}" },
    range,
  );

  assert.deepEqual(dimensions, [
    {
      cardinality: 2,
      key: "attr:http.request.method",
      name: "http.request.method",
      scope: "point",
      values: [
        { share: 0.75, value: "GET" },
        { share: 0.25, value: "POST" },
      ],
    },
    {
      cardinality: 1,
      key: "attr:server.address",
      name: "server.address",
      scope: "point",
      values: [{ share: 1, value: "db" }],
    },
    {
      cardinality: 2,
      key: "resource.service.name",
      name: "service.name",
      scope: "resource",
      values: [
        { share: 0.75, value: "checkout-api" },
        { share: 0.25, value: "inventory" },
      ],
    },
    {
      cardinality: 2,
      key: "resource.host.name",
      name: "host.name",
      scope: "resource",
      values: [
        { share: 2 / 3, value: "a" },
        { share: 1 / 3, value: "b" },
      ],
    },
  ]);
});

test("metric series filter on data-point attributes", { skip: !clickhouseUrl }, async () => {
  const rows = await metricSeries(
    ch,
    "project-1",
    "http.server.active_requests",
    { range, resourceAttrs: [{ key: "attr:http.request.method", value: "GET" }] },
    "service.name",
    { n: 1, unit: "HOUR" },
    "sum",
  );

  assert.deepEqual(
    rows.sort((a, b) => a.group.localeCompare(b.group)),
    [
      { bucket: "2026-01-01 00:00:00", group: "checkout-api", value: 7 },
      { bucket: "2026-01-01 00:00:00", group: "inventory", value: 2 },
    ],
  );
});
