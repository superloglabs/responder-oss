import { describe, expect, it } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import { OVERVIEW_BUCKETS, telemetryOverview } from "./overview.js";

type Call = { query: string; params: Record<string, unknown> };

function client(calls: Call[], rows: (query: string) => unknown[]) {
  return {
    query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      calls.push({ params: query_params ?? {}, query });
      return { json: async () => rows(query) };
    },
  } as unknown as ClickHouseClient;
}

const range = { since: "2026-10-15T12:00:00.000Z", until: "2026-10-16T12:00:00.000Z" };

describe("telemetry overview", () => {
  it("splits the window into equal buckets per service", async () => {
    const calls: Call[] = [];
    const ch = client(calls, (query) => {
      if (query.includes("FROM otel_logs")) {
        return [
          { bucket: 0, errors: 2, errors_without_exception: 1, last_seen: "2026-10-15 12:10:00", service: "billing", total: 40, warnings: 3, with_trace: 0 },
          { bucket: 47, errors: 0, errors_without_exception: 0, last_seen: "2026-10-16 11:59:00", service: "billing", total: 10, warnings: 0, with_trace: 0 },
        ];
      }
      if (query.includes("gen_ai.operation.name")) return [];
      return [{ bucket: 3, errors: 1, last_seen: "2026-10-15 13:40:00", service: "checkout", slow: 2, total: 12 }];
    });

    const overview = await telemetryOverview(ch, "project-1", range);

    expect(overview.bucketSeconds).toBe(1_800);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.params).toMatchObject({ bucketSeconds: 1_800, organizationId: "project-1" });
      expect(call.query).toMatch(/SuperlogProjectId = \{organizationId:String\}/u);
    }
    for (const call of calls.filter((call) => !call.query.includes("gen_ai.operation.name"))) {
      expect(call.query).toMatch(/least\(intDiv\(/u);
    }
    expect(overview.services.map((service) => service.name)).toEqual(["billing", "checkout"]);
    const [billing, checkout] = overview.services;
    expect(billing!.logs).toMatchObject({ errors: 2, errorsWithoutException: 1, total: 50, warnings: 3, withTrace: 0 });
    expect(billing!.logs!.buckets).toHaveLength(OVERVIEW_BUCKETS);
    expect(billing!.logs!.buckets[47]).toEqual({ errors: 0, total: 10, warnings: 0 });
    expect(billing!.traces).toBeNull();
    expect(billing!.lastSeen).toBe("2026-10-16 11:59:00");
    expect(checkout!.logs).toBeNull();
    expect(checkout!.traces).toMatchObject({ errors: 1, slow: 2, total: 12 });
    expect(checkout!.traces!.buckets[3]).toEqual({ errors: 1, slow: 2, total: 12 });
  });

  it("counts model calls that report no token usage", async () => {
    const calls: Call[] = [];
    const ch = client(calls, (query) =>
      query.includes("gen_ai.operation.name")
        ? [
            { calls: 1_204, model: "gpt-4.1-mini", service: "checkout", with_input: 0, with_model: 1_204, with_output: 0, without_usage: 1_204 },
            { calls: 296, model: "claude-haiku-4-5", service: "checkout", with_input: 296, with_model: 296, with_output: 296, without_usage: 0 },
            { calls: 12, model: "", service: "search", with_input: 0, with_model: 0, with_output: 0, without_usage: 12 },
          ]
        : [],
    );

    const { ai } = await telemetryOverview(ch, "project-1", range);

    expect(ai).toMatchObject({ calls: 1_512, callsWithInput: 296, callsWithModel: 1_500, callsWithOutput: 296, callsWithoutUsage: 1_216 });
    expect(ai.models).toEqual([
      { calls: 1_204, model: "gpt-4.1-mini" },
      { calls: 296, model: "claude-haiku-4-5" },
    ]);
    expect(ai.services).toEqual([
      { calls: 1_500, callsWithoutUsage: 1_204, service: "checkout" },
      { calls: 12, callsWithoutUsage: 12, service: "search" },
    ]);
  });
});
