import { describe, expect, it } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import { eventAggregate, eventSeries, isAdditiveAggregation, metricWindowAggregate } from "./query.js";

type Call = { query: string; params: Record<string, unknown> };

// Answers EXISTS probes with `tables` and every other query with `rows`.
function client(calls: Call[], options: { rows?: (query: string) => unknown[]; tables?: string[] } = {}) {
  return {
    query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      calls.push({ params: query_params ?? {}, query });
      const table = /^EXISTS TABLE (\w+)$/u.exec(query.trim())?.[1];
      if (table) return { json: async () => [{ result: options.tables?.includes(table) ? 1 : 0 }] };
      return { json: async () => options.rows?.(query) ?? [] };
    },
  } as unknown as ClickHouseClient;
}

const range = { since: "2026-10-14T13:52:00.000Z", until: "2026-10-14T14:52:00.000Z" };
const step = { n: 1, unit: "MINUTE" } as const;

describe("event series", () => {
  it("reads a percentile of span duration in milliseconds", async () => {
    const calls: Call[] = [];
    const ch = client(calls, { rows: () => [{ bucket: "2026-10-14 14:00:00", group_key: "api", v: 812.5 }] });

    const rows = await eventSeries(ch, "project-1", "traces", { range }, { aggregation: "p95", field: "duration" }, "service", step);

    expect(rows).toEqual([{ bucket: "2026-10-14 14:00:00", group: "api", value: 812.5 }]);
    expect(calls[0]!.query).toMatch(/quantile\(0\.95\)\(Duration \/ 1e6\) AS v/u);
    expect(calls[0]!.query).toMatch(/FROM otel_traces/u);
  });

  it("sums a numeric span attribute and skips spans without it", async () => {
    const calls: Call[] = [];
    const ch = client(calls);

    await eventSeries(
      ch,
      "project-1",
      "traces",
      { range },
      { aggregation: "sum", field: "span.gen_ai.usage.output_tokens" },
      "span.gen_ai.request.model",
      step,
    );

    const { params, query } = calls[0]!;
    expect(query).toMatch(/sum\(toFloat64OrNull\(SpanAttributes\[\{fieldKey:String\}\]\)\) AS v/u);
    expect(query).toMatch(/isNotNull\(toFloat64OrNull\(SpanAttributes\[\{fieldKey:String\}\]\)\)/u);
    expect(query).toMatch(/SpanAttributes\[\{groupKey:String\}\] AS group_key/u);
    expect(params).toMatchObject({ fieldKey: "gen_ai.usage.output_tokens", groupKey: "gen_ai.request.model" });
  });

  it("counts distinct values of a resource attribute", async () => {
    const calls: Call[] = [];
    const ch = client(calls);

    await eventSeries(ch, "project-1", "logs", { range }, { aggregation: "count_distinct", field: "customer.id" }, undefined, step);

    expect(calls[0]!.query).toMatch(/uniq\(ResourceAttributes\[\{fieldKey:String\}\]\) AS v/u);
    expect(calls[0]!.query).toMatch(/ResourceAttributes\[\{fieldKey:String\}\] != ''/u);
    expect(calls[0]!.params).toMatchObject({ fieldKey: "customer.id" });
  });

  it("counts through the per-minute rollup when it can", async () => {
    const calls: Call[] = [];
    const ch = client(calls, { rows: () => [{ bucket: "2026-10-14 14:00:00", c: 3, group_key: "api" }], tables: ["events_per_minute"] });

    const rows = await eventSeries(ch, "project-1", "traces", { range }, { aggregation: "count" }, "service", step);

    expect(rows).toEqual([{ bucket: "2026-10-14 14:00:00", group: "api", value: 3 }]);
    expect(calls.some((call) => /FROM events_per_minute/u.test(call.query))).toBe(true);
  });

  it("queries nothing for a duration of logs or a measure without a field", async () => {
    const calls: Call[] = [];
    const ch = client(calls);

    expect(await eventSeries(ch, "project-1", "logs", { range }, { aggregation: "avg", field: "duration" }, undefined, step)).toEqual([]);
    expect(await eventSeries(ch, "project-1", "traces", { range }, { aggregation: "max" }, undefined, step)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("drops buckets where nothing had a value", async () => {
    const ch = client([], { rows: () => [{ bucket: "2026-10-14 14:00:00", group_key: "", v: null }] });

    expect(await eventSeries(ch, "project-1", "traces", { range }, { aggregation: "avg", field: "duration" }, undefined, step)).toEqual([]);
  });
});

describe("event aggregate", () => {
  it("ranks groups by the measure over the whole window", async () => {
    const calls: Call[] = [];
    const ch = client(calls, { rows: () => [{ group_key: "gpt-5", v: "41.25" }] });

    const rows = await eventAggregate(
      ch,
      "project-1",
      "traces",
      { range },
      { aggregation: "max", field: "span.gen_ai.usage.input_tokens" },
      "span.gen_ai.request.model",
      10,
    );

    expect(rows).toEqual([{ group: "gpt-5", value: 41.25 }]);
    expect(calls[0]!.query).toMatch(/max\(toFloat64OrNull\(SpanAttributes\[\{fieldKey:String\}\]\)\) AS v/u);
    expect(calls[0]!.query).toMatch(/ORDER BY v DESC/u);
    expect(calls[0]!.query).not.toMatch(/toStartOfInterval/u);
    expect(calls[0]!.params).toMatchObject({ limit: 10 });
  });
});

describe("metric window aggregate", () => {
  it("reads each group as one bucket covering the window", async () => {
    const calls: Call[] = [];
    const ch = client(calls, {
      rows: () => [
        { bucket: "2026-10-14 13:52:00", group_key: "web", v: 2 },
        { bucket: "2026-10-14 13:52:00", group_key: "api", v: 9 },
      ],
    });

    const rows = await metricWindowAggregate(ch, "project-1", "queue.depth", { range }, "service", "max", 1, { kind: "gauge" });

    expect(rows).toEqual([{ group: "api", value: 9 }]);
    const query = calls.find((call) => /otel_metrics_gauge/u.test(call.query))!.query;
    expect(query).toMatch(/max\(Value\)/u);
  });
});

describe("additive aggregations", () => {
  it("adds up counts and sums only", () => {
    expect(isAdditiveAggregation(undefined)).toBe(true);
    expect(isAdditiveAggregation("count")).toBe(true);
    expect(isAdditiveAggregation("sum")).toBe(true);
    expect(isAdditiveAggregation("avg")).toBe(false);
    expect(isAdditiveAggregation("p99")).toBe(false);
    expect(isAdditiveAggregation("count_distinct")).toBe(false);
  });
});
