import { describe, expect, it, vi } from "vitest";
import { emptyAiPriceParams } from "./ai-cost.js";
import type { TelemetryClient } from "./client.js";
import { alertValues, maximumAlertGroups } from "./alert-values.js";

function recordingClient(rows: (query: string) => unknown[], queries: string[]): TelemetryClient {
  return {
    query: async ({ query }: { query: string }) => {
      queries.push(query);
      return { json: async () => rows(query) };
    },
  } as unknown as TelemetryClient;
}

const now = new Date("2026-10-14T12:00:00.000Z");
const rule = {
  aggregation: "count" as const,
  field: null,
  filter: { severity: "error" },
  groupBy: "service",
  groupMode: "single" as const,
  metricName: null,
  source: "logs" as const,
  windowMinutes: 60,
};

describe("alertValues", () => {
  it("counts a total over the exact window, without grouping or the rollup", async () => {
    const queries: string[] = [];
    const rows = await alertValues(recordingClient(() => [{ c: "7", group_key: "" }], queries), "p", rule, now);

    expect(rows).toEqual([{ group: "", value: 7 }]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/FROM otel_logs/u);
    expect(queries[0]).not.toMatch(/ServiceName AS group_key|events_per_minute/u);
    expect(queries[0]).toMatch(/TimestampTime >=/u);
  });

  it("groups per group, and fails rather than evaluate part of the groups", async () => {
    const queries: string[] = [];
    const perGroup = { ...rule, groupMode: "per_group" as const };
    await alertValues(recordingClient(() => [{ c: 3, group_key: "api" }], queries), "p", perGroup, now);
    expect(queries[0]).toMatch(/GROUP BY group_key/u);

    const many = Array.from({ length: maximumAlertGroups + 1 }, (_, index) => ({ c: 1, group_key: `g${index}` }));
    await expect(alertValues(recordingClient(() => many, []), "p", perGroup, now)).rejects.toThrow(/more than 1,000 groups/u);
  });

  it("reads only the metric of the rule's kind and unit", async () => {
    const queries: string[] = [];
    const metricRule = {
      ...rule,
      aggregation: "avg" as const,
      filter: { metricKind: "gauge" as const, metricUnit: "ms" },
      metricName: "rpc.duration",
      source: "metric" as const,
    };
    await alertValues(recordingClient(() => [], queries), "p", metricRule, now);

    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/FROM otel_metrics_gauge/u);
    expect(queries[0]).toMatch(/MetricUnit = \{metricUnit:String\}/u);
  });

  it("sums AI cost of model calls at the prices resolved for the window", async () => {
    const queries: string[] = [];
    const prices = vi.fn(async () => ({ ...emptyAiPriceParams(), aiPriceInput: [3], aiPriceKey: ["anthropic|claude-sonnet-4-5|"] }));
    const cost = { ...rule, aggregation: "sum" as const, field: "ai:cost", filter: {}, source: "traces" as const };

    const rows = await alertValues(recordingClient(() => [{ group_key: "", v: 12.5 }], queries), "p", cost, now, prices);

    expect(rows).toEqual([{ group: "", value: 12.5 }]);
    expect(prices).toHaveBeenCalledWith(expect.anything(), "p", {
      range: { since: "2026-10-14T11:00:00.000Z", until: "2026-10-14T12:00:00.000Z" },
      resourceAttrs: [],
    });
    expect(queries[0]).toMatch(/arrayFirstIndex/u);
    expect(queries[0]).toMatch(/SpanId NOT IN/u);
  });

  it("reads other span fields without prices", async () => {
    const queries: string[] = [];
    const prices = vi.fn();
    const latency = { ...rule, aggregation: "p95" as const, field: "duration", filter: {}, source: "traces" as const };

    await alertValues(recordingClient(() => [], queries), "p", latency, now, prices);

    expect(prices).not.toHaveBeenCalled();
    expect(queries[0]).toMatch(/quantile\(0\.95\)\(Duration \/ 1e6\)/u);
  });
});
