import { describe, expect, it } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import { countSeries, eventSeries, metricSeries } from "./query.js";

const range = { since: "2026-10-14T12:00:00Z", until: "2026-10-14T13:00:00Z" };
const step = { n: 5, unit: "MINUTE" } as const;

describe("activation chart group isolation", () => {
  it.each(["api", ""])("restricts all telemetry sources before limiting rows for group %s", async (groupValue) => {
    const calls: { query: string; query_params?: Record<string, unknown> }[] = [];
    const ch = { query: async (call: typeof calls[number]) => {
      calls.push(call);
      return { json: async () => [] };
    } } as unknown as ClickHouseClient;
    await countSeries(ch, "project", "logs", { range }, "service", step, groupValue);
    await eventSeries(ch, "project", "traces", { range }, { aggregation: "avg", field: "duration" }, "service", step, undefined, groupValue);
    await metricSeries(ch, "project", "requests", { range }, "service", step, "sum", { kind: "sum", groupValue });
    await metricSeries(ch, "project", "temperature", { range }, "service", step, "avg", { kind: "gauge", groupValue });
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.query_params?.selectedGroup).toBe(groupValue);
      expect(call.query).toMatch(/WHERE[\s\S]*ServiceName = \{selectedGroup:String\}[\s\S]*LIMIT/);
    }
  });
});
