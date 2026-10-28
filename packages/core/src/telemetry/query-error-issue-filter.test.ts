import { describe, expect, it } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import { countSeries, queryLogs, queryTracesAggregated } from "./query.js";

type Call = { query: string; params: Record<string, unknown> };

function client(calls: Call[]) {
  return {
    query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      calls.push({ params: query_params ?? {}, query });
      if (/^EXISTS TABLE/u.test(query.trim())) return { json: async () => [{ result: 0 }] };
      return { json: async () => [] };
    },
  } as unknown as ClickHouseClient;
}

const range = { since: "2026-10-14T13:52:00.000Z", until: "2026-10-14T14:52:00.000Z" };
const issueId = "b2d5c6e4-fa74-48c9-a9d2-907f016b44fb";
const filter = [{ key: "field.error_issue", op: "eq" as const, value: issueId }];

describe("error issue filter", () => {
  it("matches a log issue's exact log rows and the logs of a span issue's spans", async () => {
    const calls: Call[] = [];
    await queryLogs(client(calls), "project-1", { limit: 100, range, resourceAttrs: filter });

    const { query, params } = calls[0]!;
    expect(query).toContain("(ServiceName, Timestamp, TraceId, SpanId) IN (SELECT service, Timestamp, trace_id, span_id FROM error_issue_events WHERE project_id = {organizationId:String} AND issue_id = {fattr_v_0:String} AND kind = 'log'");
    expect(query).toContain("(TraceId, SpanId) IN (SELECT trace_id, span_id FROM error_issue_events WHERE project_id = {organizationId:String} AND issue_id = {fattr_v_0:String} AND kind = 'span' AND span_id != ''");
    // The events are bounded by the query's window.
    expect(query).toContain("AND Timestamp >= (parseDateTime64BestEffortOrZero({since:String})) - INTERVAL 1 HOUR AND Timestamp <= parseDateTime64BestEffortOrZero({until:String})");
    expect(params).toMatchObject({ fattr_v_0: issueId, organizationId: "project-1" });
  });

  it("matches the spans of an issue's events in trace search", async () => {
    const calls: Call[] = [];
    await queryTracesAggregated(client(calls), "project-1", { limit: 50, range, resourceAttrs: filter });

    const search = calls.find((call) => call.query.includes("error_issue_events"))!;
    expect(search.query).toContain("TraceId IN (");
    expect(search.query).toContain("(TraceId, SpanId) IN (SELECT trace_id, span_id FROM error_issue_events WHERE project_id = {organizationId:String} AND issue_id = {fattr_v_0:String} AND span_id != ''");
    expect(search.params).toMatchObject({ fattr_v_0: issueId });
  });

  it("excludes an issue's events with neq and ignores not_contains", async () => {
    const calls: Call[] = [];
    await queryLogs(client(calls), "project-1", { limit: 100, range, resourceAttrs: [{ key: "field.error_issue", op: "neq", value: issueId }] });
    expect(calls[0]!.query).toContain("NOT ((ServiceName, Timestamp, TraceId, SpanId) IN");

    const ignored: Call[] = [];
    await queryLogs(client(ignored), "project-1", { limit: 100, range, resourceAttrs: [{ key: "field.error_issue", op: "not_contains", value: issueId }] });
    expect(ignored[0]!.query).not.toContain("error_issue_events");
  });

  it("filters counts the same way", async () => {
    const calls: Call[] = [];
    await countSeries(client(calls), "project-1", "logs", { range, resourceAttrs: filter }, "severity", { n: 30, unit: "SECOND" });
    expect(calls.some((call) => call.query.includes("FROM error_issue_events"))).toBe(true);
  });
});
