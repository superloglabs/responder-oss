import { describe, expect, it, vi } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import { OVERVIEW_BUCKETS, OVERVIEW_DETAIL_SECONDS, telemetryOverview, telemetryOverviewDetails } from "./overview.js";

type Call = { query: string; params: Record<string, unknown>; settings: Record<string, unknown> | undefined };

function client(calls: Call[], rows: (query: string) => unknown[], options: { rollup?: boolean } = {}) {
  let running = 0;
  const state = { maxRunning: 0 };
  const ch = {
    query: async ({
      clickhouse_settings,
      query,
      query_params,
    }: {
      clickhouse_settings?: Record<string, unknown>;
      query: string;
      query_params?: Record<string, unknown>;
    }) => {
      if (query.startsWith("EXISTS TABLE")) {
        return { json: async () => [{ result: options.rollup === false ? 0 : 1 }] };
      }
      calls.push({ params: query_params ?? {}, query, settings: clickhouse_settings });
      running += 1;
      state.maxRunning = Math.max(state.maxRunning, running);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const result = rows(query);
        return { json: async () => result };
      } finally {
        running -= 1;
      }
    },
  } as unknown as ClickHouseClient;
  return { ch, state };
}

const range = { since: "2026-10-15T12:00:00.000Z", until: "2026-10-16T12:00:00.000Z" };

describe("telemetry overview", () => {
  it("counts each service's logs and spans from the per-minute rollup", async () => {
    const calls: Call[] = [];
    const { ch } = client(calls, () => [
      { bucket: 0, errors: 2, last_seen: "2026-10-15 12:10:00", service: "billing", signal: "logs", total: 40, warnings: 3 },
      { bucket: 47, errors: 0, last_seen: "2026-10-16 11:59:00", service: "billing", signal: "logs", total: 10, warnings: 0 },
      { bucket: 3, errors: 4, last_seen: "2026-10-15 13:40:00", service: "checkout", signal: "traces", total: 120, warnings: 0 },
    ]);

    const overview = await telemetryOverview(ch, "project-1", range);

    expect(overview.bucketSeconds).toBe(1_800);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toContain("FROM events_per_minute");
    expect(calls[0]!.query).toMatch(/project_id = \{organizationId:String\}/u);
    expect(calls[0]!.query).toContain("status_code IN ('Error', 'STATUS_CODE_ERROR')");
    expect(calls[0]!.params).toMatchObject({ bucketSeconds: 1_800, organizationId: "project-1" });
    expect(overview.ai).toBeNull();
    expect(overview.services.map((service) => service.name)).toEqual(["checkout", "billing"]);
    const [checkout, billing] = overview.services;
    expect(billing!.logs).toMatchObject({ errors: 2, errorsWithoutException: null, total: 50, warnings: 3, withTrace: null });
    expect(billing!.logs!.buckets).toHaveLength(OVERVIEW_BUCKETS);
    expect(billing!.logs!.buckets[47]).toEqual({ errors: 0, total: 10, warnings: 0 });
    expect(billing!.traces).toBeNull();
    expect(billing!.lastSeen).toBe("2026-10-16 11:59:00");
    expect(checkout!.logs).toBeNull();
    expect(checkout!.traces).toMatchObject({ errors: 4, slow: null, total: 120 });
    expect(checkout!.traces!.buckets[3]).toEqual({ errors: 4, requests: 0, slow: 0, total: 120 });
  });

  it("counts from raw rows when the deployment has no rollup", async () => {
    const calls: Call[] = [];
    const { ch } = client(
      calls,
      (query) => [
        query.includes("FROM otel_logs")
          ? { bucket: 0, errors: 1, last_seen: "2026-10-15 12:10:00", service: "billing", signal: "logs", total: 5, warnings: 0 }
          : { bucket: 0, errors: 1, last_seen: "2026-10-15 12:10:00", service: "billing", signal: "traces", total: 9, warnings: 0 },
      ],
      { rollup: false },
    );

    const overview = await telemetryOverview(ch, "project-1", range);

    expect(calls.map((call) => call.query.match(/FROM (\w+)/u)?.[1])).toEqual(["otel_logs", "otel_traces"]);
    for (const call of calls) expect(call.query).toMatch(/SuperlogProjectId = \{organizationId:String\}/u);
    expect(calls[1]!.query).toContain("StatusCode IN ('Error', 'STATUS_CODE_ERROR')");
    expect(overview.services[0]).toMatchObject({ logs: { total: 5 }, name: "billing", traces: { errors: 1, total: 9 } });
  });
});

describe("telemetry overview details", () => {
  it("counts slow requests, exception details and trace links under a time limit", async () => {
    const calls: Call[] = [];
    const { ch, state } = client(calls, (query) => {
      if (query.includes("AS requests")) return [{ bucket: 3, requests: 12, service: "checkout", slow: 2 }];
      if (query.includes("exception.type")) return [{ c: 1, service: "billing" }];
      if (query.includes("TraceId != ''")) return [{ c: 0, service: "billing" }];
      return [];
    });

    const details = await telemetryOverviewDetails(ch, "project-1", range);

    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.query).toMatch(/SuperlogProjectId = \{organizationId:String\}/u);
      expect(call.params).toMatchObject({ bucketSeconds: 1_800, organizationId: "project-1" });
      expect(call.settings).toEqual({ max_execution_time: OVERVIEW_DETAIL_SECONDS });
    }
    expect(state.maxRunning).toBe(2);
    expect(details).toMatchObject({
      ai: { calls: 0 },
      errorsWithoutException: { billing: 1 },
      requests: [{ bucket: 3, requests: 12, service: "checkout", slow: 2 }],
      withTrace: { billing: 0 },
    });
  });

  it("leaves out the details that run out of time", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { ch } = client([], (query) => {
      if (query.includes("AS requests")) return [{ bucket: 0, requests: 1, service: "checkout", slow: 0 }];
      throw new Error("Timeout exceeded: elapsed 8.1 seconds, maximum: 8");
    });

    const details = await telemetryOverviewDetails(ch, "project-1", range);

    expect(details).toEqual({
      ai: null,
      errorsWithoutException: null,
      requests: [{ bucket: 0, requests: 1, service: "checkout", slow: 0 }],
      withTrace: null,
    });
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("counts model calls that report no token usage", async () => {
    const { ch } = client([], (query) =>
      query.includes("gen_ai.operation.name")
        ? [
            { calls: 1_204, completed: 1_204, generated: 1_204, model: "gpt-4.1-mini", service: "checkout", with_input: 0, with_model: 1_204, with_output: 0, without_usage: 1_204 },
            { calls: 300, completed: 296, generated: 296, model: "claude-haiku-4-5", service: "checkout", with_input: 296, with_model: 300, with_output: 296, without_usage: 0 },
            { calls: 12, completed: 12, generated: 0, model: "", service: "search", with_input: 0, with_model: 0, with_output: 0, without_usage: 12 },
          ]
        : [],
    );

    const { ai } = await telemetryOverviewDetails(ch, "project-1", range);

    expect(ai).toMatchObject({
      calls: 1_516,
      callsWithInput: 296,
      callsWithModel: 1_504,
      callsWithOutput: 296,
      callsWithoutUsage: 1_216,
      completedCalls: 1_512,
      completedGenerations: 1_500,
    });
    expect(ai!.models).toEqual([
      { calls: 1_204, model: "gpt-4.1-mini" },
      { calls: 300, model: "claude-haiku-4-5" },
    ]);
    expect(ai!.services).toEqual([
      { calls: 1_504, callsWithoutUsage: 1_204, service: "checkout" },
      { calls: 12, callsWithoutUsage: 12, service: "search" },
    ]);
  });
});
