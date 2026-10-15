import { describe, expect, it } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import { countAggregate, countSeries, queryLogs, queryTracesAggregated, traceOverview } from "./query.js";

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

describe("count series groupings", () => {
  it("groups raw logs by level and raw spans by status", async () => {
    const calls: Call[] = [];
    const ch = client(calls);

    await countSeries(ch, "project-1", "logs", { range, search: "timeout" }, "severity", { n: 30, unit: "SECOND" });
    await countSeries(ch, "project-1", "traces", { range }, "status", { n: 30, unit: "SECOND" });

    const [logs, traces] = calls.filter((call) => /\bFROM otel_/u.test(call.query));
    expect(logs!.query).toMatch(/upper\(SeverityText\) AS group_key/u);
    expect(traces!.query).toMatch(/StatusCode AS group_key/u);
  });

  it("reads level and status groupings from the per-minute rollup", async () => {
    const calls: Call[] = [];
    const ch = client(calls, { tables: ["events_per_minute"] });

    await countSeries(ch, "project-1", "logs", { range }, "severity", { n: 1, unit: "MINUTE" });
    await countSeries(ch, "project-1", "traces", { range }, "status", { n: 1, unit: "MINUTE" });

    const [logs, traces] = calls.filter((call) => /\bFROM events_per_minute\b/u.test(call.query));
    expect(logs!.query).toMatch(/severity AS group_key/u);
    expect(traces!.query).toMatch(/status_code AS group_key/u);
  });
});

describe("explorer value lists", () => {
  it("matches any listed service or level in logs and their counts", async () => {
    const calls: Call[] = [];
    const ch = client(calls);

    await queryLogs(ch, "project-1", { limit: 10, range, services: ["api", "web"], severities: ["error", "WARN"] });
    await countAggregate(ch, "project-1", "logs", { range, severities: ["error"] }, "service", 20);

    const [logs, counts] = calls;
    expect(logs!.query).toMatch(/ServiceName IN \{services:Array\(String\)\}/u);
    expect(logs!.query).toMatch(/upper\(SeverityText\) IN \{severities:Array\(String\)\}/u);
    expect(logs!.params).toMatchObject({ services: ["api", "web"], severities: ["ERROR", "WARN"] });
    expect(counts!.query).toMatch(/upper\(SeverityText\) IN \{severities:Array\(String\)\}/u);
    expect(counts!.params).toMatchObject({ severities: ["ERROR"] });
  });

  it("reads listed levels from the rollup, and listed operations from raw spans", async () => {
    const calls: Call[] = [];
    const ch = client(calls, { tables: ["events_per_minute"] });

    await countSeries(ch, "project-1", "logs", { range, severities: ["error"] }, "severity", { n: 1, unit: "MINUTE" });
    await countSeries(ch, "project-1", "traces", { range, spanNames: ["GET /cart"] }, "status", { n: 1, unit: "MINUTE" });

    const [rollup, raw] = calls.filter((call) => /\bFROM (events_per_minute|otel_traces)\b/u.test(call.query));
    expect(rollup!.query).toMatch(/FROM events_per_minute/u);
    expect(rollup!.query).toMatch(/severity IN \{severities:Array\(String\)\}/u);
    expect(rollup!.params).toMatchObject({ severities: ["ERROR"] });
    expect(raw!.query).toMatch(/FROM otel_traces/u);
    expect(raw!.query).toMatch(/SpanName IN \{spanNames:Array\(String\)\}/u);
  });

  it("selects traces with a span in any listed status, from the raw spans", async () => {
    const calls: Call[] = [];
    const ch = client(calls, { tables: ["otel_traces_recent", "otel_traces_summary"] });

    await queryTracesAggregated(ch, "project-1", { limit: 50, range, statusCodes: ["STATUS_CODE_ERROR"] });

    const query = calls.find((call) => /GROUP BY TraceId/u.test(call.query));
    expect(query!.query).toMatch(/StatusCode IN \{statusCodes:Array\(String\)\}/u);
    expect(query!.params).toMatchObject({ statusCodes: ["STATUS_CODE_ERROR"] });
    expect(calls.some((call) => /otel_traces_summary/u.test(call.query))).toBe(false);
  });

  it("counts spans per operation", async () => {
    const calls: Call[] = [];

    await countAggregate(client(calls), "project-1", "traces", { range }, "operation", 20);

    expect(calls[0]!.query).toMatch(/SELECT SpanName AS group_key/u);
  });
});

describe("explorer trace duration", () => {
  it("counts spans of traces that last at least the minimum, not spans that do", async () => {
    const calls: Call[] = [];
    const ch = client(calls, { tables: ["events_per_minute"] });

    await countSeries(ch, "project-1", "traces", { minTraceDurationMs: 600, range }, "status", { n: 1, unit: "MINUTE" });

    const query = calls.find((call) => /\bFROM otel_traces\b/u.test(call.query))!;
    expect(query.query).not.toMatch(/Duration >= \{minDurationNs:UInt64\}/u);
    expect(query.query).toMatch(/TraceId IN \(/u);
    expect(query.query).toMatch(/HAVING .*>= \{minTraceDurationNs:UInt64\}/su);
    expect(query.params).toMatchObject({ minTraceDurationNs: 600_000_000 });
    expect(calls.some((call) => /FROM events_per_minute/u.test(call.query))).toBe(false);
  });
});

describe("identifier filters", () => {
  it("excludes a trace ID with !=", async () => {
    const calls: Call[] = [];

    await queryLogs(client(calls), "project-1", {
      limit: 10,
      range,
      resourceAttrs: [{ key: "field.trace_id", op: "neq", value: "abc" }],
    });

    expect(calls[0]!.query).toMatch(/TraceId != \{fattr_v_0:String\}/u);
  });
});

describe("trace overview", () => {
  it("summarizes a service's entry spans, client calls, and errors", async () => {
    const calls: Call[] = [];
    const ch = client(calls, {
      rows: (query) => {
        if (/GROUP BY bucket/u.test(query)) {
          return [{ bucket: "2026-10-14 14:42:00", errors: "3", p95_ms: 980.5, requests: "40" }];
        }
        if (/SPAN_KIND_CLIENT/u.test(query)) return [{ errors: 2, name: "api.stripe.com", p95_ms: 980, requests: 12 }];
        if (/AS message/u.test(query)) {
          return [{
            first_seen: "2026-10-14 14:42:01.000000000",
            message: "upstream timeout",
            service: "checkout-api",
            span_name: "HTTP POST",
            spans: "9",
            traces: "7",
          }];
        }
        if (/GROUP BY name/u.test(query)) return [{ errors: 4, name: "POST /checkout", p95_ms: 1980, requests: 412 }];
        return [{ errors: "5", p95_ms: "1240", requests: "1912" }];
      },
    });

    const overview = await traceOverview(ch, "project-1", { range, service: "checkout-api", step: { n: 1, unit: "MINUTE" } });

    expect(overview).toEqual({
      dependencies: [{ errors: 2, name: "api.stripe.com", p95_ms: 980, requests: 12 }],
      errors: [{
        first_seen: "2026-10-14 14:42:01.000000000",
        message: "upstream timeout",
        service: "checkout-api",
        span_name: "HTTP POST",
        spans: 9,
        traces: 7,
      }],
      operations: [{ errors: 4, name: "POST /checkout", p95_ms: 1980, requests: 412 }],
      series: [{ bucket: "2026-10-14 14:42:00", errors: 3, p95_ms: 980.5, requests: 40 }],
      totals: { errors: 5, p95_ms: 1240, requests: 1912 },
    });
    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.query).toMatch(/SuperlogProjectId = \{organizationId:String\}/u);
      expect(call.query).toMatch(/ServiceName = \{service:String\}/u);
      expect(call.params).toMatchObject({ organizationId: "project-1", service: "checkout-api" });
    }
  });

  it("groups top errors by message, service and span name", async () => {
    const calls: Call[] = [];

    await traceOverview(client(calls), "project-1", { range, step: { n: 1, unit: "MINUTE" } });

    const errors = calls.find((call) => /AS message/u.test(call.query))!;
    expect(errors.query).toMatch(/GROUP BY message, service, span_name/u);
    expect(errors.query).not.toMatch(/any\(/u);
  });

  it("reports zero totals for an empty window", async () => {
    const overview = await traceOverview(client([]), "project-1", { range, step: { n: 1, unit: "MINUTE" } });

    expect(overview.totals).toEqual({ errors: 0, p95_ms: 0, requests: 0 });
    expect(overview.series).toEqual([]);
  });
});
