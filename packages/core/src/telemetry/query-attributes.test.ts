import type { ClickHouseClient } from "@clickhouse/client";
import { describe, expect, it } from "vitest";
import { listAttributeValues, metricSeries, queryMetrics } from "./query.js";

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

  it("leaves out traces when a filter is on a log attribute", async () => {
    const queries: RecordedQuery[] = [];

    await listAttributeValues(recordingClient(queries), "project-1", "service.name", undefined, 200, undefined, undefined, [
      { key: "log.level", value: "error" },
    ]);

    expect(queries[0]!.query).toContain("FROM otel_logs");
    expect(queries[0]!.query).not.toContain("FROM otel_traces");
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
});
