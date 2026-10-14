import type { ClickHouseClient } from "@clickhouse/client";
import { describe, expect, it } from "vitest";
import { listAttributeValues, listMetricCatalog, listMetricDimensions, metricSeries, queryLogs, queryMetrics } from "./query.js";

type RecordedQuery = { query: string; params: Record<string, unknown> };

function recordingClient(queries: RecordedQuery[]): ClickHouseClient {
  return {
    query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      queries.push({ query, params: query_params ?? {} });
      return { json: async () => [] };
    },
  } as unknown as ClickHouseClient;
}

describe("attribute value discovery", () => {
  it.each([
    ["resource.deployment.environment", undefined],
    ["log.http.route", "logs" as const],
    ["span.http.route", "traces" as const],
  ])("caps the rows each %s scan reads before grouping", async (key, source) => {
    const queries: RecordedQuery[] = [];

    await listAttributeValues(recordingClient(queries), "project-1", key, undefined, 50, source);

    const [{ query }] = queries;
    const scans = query.match(/FROM otel_(?:logs|traces)\b[\s\S]*?(?=\)\s*GROUP BY v)/gu) ?? [];
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) expect(scan).toMatch(/LIMIT 1000000\s*$/u);
  });
});

describe("attribute values filtered by other attributes", () => {
  it("counts only rows that match the filters, with several values matching any of them", async () => {
    const queries: RecordedQuery[] = [];

    await listAttributeValues(recordingClient(queries), "project-1", "http.route", undefined, 200, undefined, undefined, [
      { key: "service.name", value: "checkout" },
      { key: "deployment.environment", value: "prod", values: ["prod", "staging"] },
    ]);

    const [{ params, query }] = queries;
    expect(query).toContain("AND ServiceName = {fattr_r_v_0:String}");
    expect(query).toContain("AND ResourceAttributes[{fattr_r_k_1:String}] IN {fattr_r_v_1:Array(String)}");
    expect(params).toMatchObject({ fattr_r_k_1: "deployment.environment", fattr_r_v_0: "checkout", fattr_r_v_1: ["prod", "staging"] });
  });

  it("applies field filters to each table that has the field", async () => {
    const queries: RecordedQuery[] = [];

    await listAttributeValues(recordingClient(queries), "project-1", "service.name", undefined, 200, undefined, undefined, [
      { key: "field.trace_id", value: "a", values: ["a", "b"] },
      { key: "field.severity_number", value: "17" },
    ]);

    const [{ params, query }] = queries;
    const logs = query.slice(query.indexOf("FROM otel_logs"), query.indexOf("FROM otel_traces"));
    const traces = query.slice(query.indexOf("FROM otel_traces"));
    expect(logs).toContain("TraceId IN {fattr_f_v_0:Array(String)}");
    expect(logs).toContain("toString(SeverityNumber) = {fattr_f_v_1:String}");
    expect(traces).toContain("TraceId IN {fattr_f_v_0:Array(String)}");
    expect(traces).not.toContain("SeverityNumber");
    expect(params).toMatchObject({ fattr_f_v_0: ["a", "b"], fattr_f_v_1: "17" });
  });

  it("leaves out traces when a filter is on a log attribute", async () => {
    const queries: RecordedQuery[] = [];

    await listAttributeValues(recordingClient(queries), "project-1", "service.name", undefined, 200, undefined, undefined, [
      { key: "log.level", value: "error" },
    ]);

    expect(queries[0]!.query).toContain("FROM otel_logs");
    expect(queries[0]!.query).not.toContain("FROM otel_traces");
  });
});

describe("field filters", () => {
  it("keeps the operator when a field filter has several values", async () => {
    const queries: RecordedQuery[] = [];

    await queryLogs(recordingClient(queries), "project-1", {
      limit: 10,
      resourceAttrs: [
        { key: "field.trace_id", op: "neq", value: "a", values: ["a", "b"] },
        { key: "field.span_id", value: "c", values: ["c", "d"] },
        { key: "field.severity_number", op: "neq", value: "9" },
      ],
    });

    const [{ params, query }] = queries;
    expect(query).toContain("TraceId NOT IN {fattr_v_0:Array(String)}");
    expect(query).toContain("SpanId IN {fattr_v_1:Array(String)}");
    expect(query).toContain("toString(SeverityNumber) != {fattr_v_2:String}");
    expect(params).toMatchObject({ fattr_v_0: ["a", "b"], fattr_v_1: ["c", "d"], fattr_v_2: "9" });
  });
});

describe("metric attribute filters", () => {
  const range = { since: "2026-07-23T00:00:00.000Z", until: "2026-07-23T01:00:00.000Z" };

  it("filters series by a discovered resource attribute without its scope prefix", async () => {
    const queries: RecordedQuery[] = [];

    await metricSeries(
      recordingClient(queries),
      "project-1",
      "queue.depth",
      { range, resourceAttrs: [{ key: "resource.deployment.environment", value: "prod" }] },
      "resource.cloud.region",
      { n: 1, unit: "MINUTE" },
    );

    expect(queries.length).toBeGreaterThan(0);
    for (const { params } of queries) {
      expect(params.attr_k_0).toBe("deployment.environment");
      expect(params.groupKey).toBe("cloud.region");
    }
  });

  it("filters raw metric points by a discovered resource attribute without its scope prefix", async () => {
    const queries: RecordedQuery[] = [];

    await queryMetrics(recordingClient(queries), "project-1", {
      range,
      resourceAttrs: [{ key: "resource.deployment.environment", value: "prod" }],
      limit: 10,
    });

    expect(queries.length).toBeGreaterThan(0);
    for (const { params } of queries) expect(params.attr_k_0).toBe("deployment.environment");
  });

  it("keeps unscoped resource attribute keys as they are", async () => {
    const queries: RecordedQuery[] = [];

    await metricSeries(
      recordingClient(queries),
      "project-1",
      "queue.depth",
      { range, resourceAttrs: [{ key: "deployment.environment", value: "prod" }] },
      "cloud.region",
      { n: 1, unit: "MINUTE" },
    );

    for (const { params } of queries) {
      expect(params.attr_k_0).toBe("deployment.environment");
      expect(params.groupKey).toBe("cloud.region");
    }
  });

  it("filters and groups series by the same data-point attribute", async () => {
    const queries: RecordedQuery[] = [];

    await metricSeries(
      recordingClient(queries),
      "project-1",
      "http.server.request.duration",
      {
        range,
        resourceAttrs: [
          { key: "resource.deployment.environment", value: "prod" },
          { key: "attr:http.route", value: "POST /checkout" },
        ],
      },
      "attr:http.route",
      { n: 1, unit: "MINUTE" },
    );

    expect(queries.length).toBeGreaterThan(0);
    for (const { params, query } of queries) {
      expect(query).toContain("ResourceAttributes[{attr_k_0:String}] = {attr_v_0:String}");
      expect(query).toContain("Attributes[{pattr_k_0:String}] = {pattr_v_0:String}");
      expect(params).toMatchObject({
        attr_k_0: "deployment.environment",
        groupKey: "http.route",
        pattr_k_0: "http.route",
        pattr_v_0: "POST /checkout",
      });
    }
  });
});

describe("metric series of one kind", () => {
  it("reads only the points of the chosen unit", async () => {
    const queries: RecordedQuery[] = [];

    await metricSeries(
      recordingClient(queries),
      "project-1",
      "rpc.duration",
      { range: { since: "2026-07-23T00:00:00.000Z", until: "2026-07-23T01:00:00.000Z" }, resourceAttrs: [] },
      undefined,
      { n: 1, unit: "MINUTE" },
      undefined,
      { kind: "gauge", unit: "ms" },
    );

    expect(queries).toHaveLength(1);
    expect(queries[0]!.query).toContain("MetricUnit = {metricUnit:String}");
    expect(queries[0]!.params.metricUnit).toBe("ms");
  });

  it("reads only the table of the chosen kind", async () => {
    const queries: RecordedQuery[] = [];

    await metricSeries(
      recordingClient(queries),
      "project-1",
      "http.server.request.duration",
      { range: { since: "2026-07-23T00:00:00.000Z", until: "2026-07-23T01:00:00.000Z" }, resourceAttrs: [] },
      undefined,
      { n: 1, unit: "MINUTE" },
      "avg",
      { kind: "histogram" },
    );

    const tables = new Set(queries.flatMap(({ query }) => query.match(/FROM otel_metrics_\w+/gu) ?? []));
    expect([...tables]).toEqual(["FROM otel_metrics_histogram"]);
  });
});

describe("the metric catalog", () => {
  // Lists two gauges with their counts, and details read from `sampledPoints`
  // points of the busy one.
  function catalogClient(names: { busy: number; quiet: number }, sampledPoints: number): ClickHouseClient {
    return {
      query: async ({ query }: { query: string }) => ({
        json: async () => {
          if (!query.includes("FROM otel_metrics_gauge")) return [];
          if (query.includes("count() AS c")) {
            return [
              { c: names.busy, name: "busy", unit: "" },
              { c: names.quiet, name: "quiet", unit: "" },
            ];
          }
          return [
            { attributes: [], description: "", name: "busy", points: sampledPoints, series: 1, services: ["api"], unit: "" },
            { attributes: [], description: "", name: "quiet", points: names.quiet, series: 1, services: ["api"], unit: "" },
          ];
        },
      }),
    } as unknown as ClickHouseClient;
  }
  const window = { since: "2026-07-23T00:00:00.000Z", until: "2026-07-23T01:00:00.000Z" };

  it("marks services complete only for metrics a capped scan read in full", async () => {
    const catalog = await listMetricCatalog(catalogClient({ busy: 2_000_000, quiet: 3 }, 999_997), "project-1", window);

    expect(catalog.map((metric) => [metric.name, metric.servicesComplete])).toEqual([
      ["busy", false],
      ["quiet", true],
    ]);
  });

  it("trusts every service list when the scan was not capped", async () => {
    // A rollup count includes the hour the window starts in, so it can
    // exceed what the exact window holds.
    const catalog = await listMetricCatalog(catalogClient({ busy: 10, quiet: 3 }, 4), "project-1", window);

    expect(catalog.every((metric) => metric.servicesComplete)).toBe(true);
  });

  it("lists more metric names than the picker", async () => {
    const queries: RecordedQuery[] = [];

    await listMetricCatalog(recordingClient(queries), "project-1", {
      since: "2026-07-23T00:00:00.000Z",
      until: "2026-07-23T01:00:00.000Z",
    });

    const nameQueries = queries.filter(({ query }) => query.includes("count() AS c"));
    expect(nameQueries.length).toBeGreaterThan(0);
    for (const { query } of nameQueries) expect(query).toMatch(/LIMIT 5000\s*$/u);
  });
});

describe("metric dimension sampling", () => {
  const range = { since: "2026-07-23T00:00:00.000Z", until: "2026-07-23T01:00:00.000Z" };

  // Answers the rollup probes and point counts, records every query, and
  // returns no dimensions.
  function rollupClient(queries: RecordedQuery[], rollupPoints: number | null, rawPoints = 0): ClickHouseClient {
    return {
      query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
        queries.push({ query, params: query_params ?? {} });
        if (query.startsWith("EXISTS TABLE")) return { json: async () => [{ result: rollupPoints === null ? 0 : 1 }] };
        if (query.includes("FROM metric_names_per_hour")) return { json: async () => [{ points: rollupPoints }] };
        if (query.includes("count() AS points")) return { json: async () => [{ points: rawPoints }] };
        return { json: async () => [] };
      },
    } as unknown as ClickHouseClient;
  }

  function dimensionScan(queries: RecordedQuery[]): RecordedQuery {
    const scan = queries.find(({ query }) => query.includes("ARRAY JOIN pairs"));
    expect(scan).toBeDefined();
    return scan!;
  }

  it("thins a busy metric's points evenly before the row cap", async () => {
    const queries: RecordedQuery[] = [];

    await listMetricDimensions(rollupClient(queries, 1_000_000), "project-1", { kind: "gauge", name: "queue.depth" }, range);

    const { params, query } = dimensionScan(queries);
    expect(query).toContain("% {stride:UInt64} = 0");
    expect(params.stride).toBe(5);
  });

  it("counts a metric the rollup does not cover from its table", async () => {
    const queries: RecordedQuery[] = [];

    await listMetricDimensions(
      rollupClient(queries, 0, 1_000_000),
      "project-1",
      { kind: "exponential_histogram", name: "rpc.duration" },
      range,
    );

    expect(queries.some(({ query }) => /count\(\) AS points\s+FROM otel_metrics_exp_histogram/u.test(query))).toBe(true);
    expect(dimensionScan(queries).params.stride).toBe(5);
  });

  it("reads every point of a metric under the row cap", async () => {
    const queries: RecordedQuery[] = [];

    await listMetricDimensions(rollupClient(queries, 150_000), "project-1", { kind: "gauge", name: "queue.depth" }, range);

    expect(dimensionScan(queries).query).not.toContain("stride");
  });
});
