import { describe, expect, it } from "vitest";
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
});
