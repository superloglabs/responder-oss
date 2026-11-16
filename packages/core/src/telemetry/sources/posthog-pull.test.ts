import { describe, expect, it, vi } from "vitest";
import type { PostHogFetch } from "../../integrations/posthog-api.js";
import type { OtlpLogsRequest } from "./otlp-json.js";
import type { PostHogLogLine } from "./posthog-logs.js";
import { pullPostHogSource, readPostHogErrorWindow } from "./posthog-pull.js";

const now = new Date("2026-11-16T10:00:00Z");

function line(timestamp: string, body = "payment failed", severity = "error"): PostHogLogLine {
  return {
    attributes: { "http.route": "/pay" },
    body,
    resource_attributes: { "service.name": "api" },
    resource_fingerprint: "1",
    severity_number: severity === "fatal" ? 21 : 17,
    severity_text: severity,
    span_id: "AAAAAAAAAAA=",
    timestamp,
    trace_id: "AAAAAAAAAAAAAAAAAAAAAA==",
    uuid: `${timestamp}-${body}`,
  };
}

type Query = {
  after?: string;
  dateRange: { date_from: string; date_to: string };
  excludeAttributes?: boolean;
  limit: number;
  orderBy?: string;
  severityLevels?: string[];
};

// A PostHog project whose logs API answers like PostHog's: lines in the date
// range, newest first, `limit` at a time, with a cursor that narrows the
// range to before the last line.
function posthog(lines: PostHogLogLine[], options: { home?: "eu" | "us" } = {}) {
  const queries: Array<{ path: string; query: Query }> = [];
  const fetchFn = vi.fn<PostHogFetch>(async (url, init) => {
    const { host, pathname } = new URL(url);
    if (!host.startsWith(options.home ?? "eu")) return Response.json({ detail: "Invalid token" }, { status: 401 });
    if (pathname === "/api/users/@me/") return Response.json({ organization: null, organizations: [] });
    const { query } = JSON.parse(String(init.body)) as { query: Query };
    queries.push({ path: pathname, query });
    let to = Date.parse(query.dateRange.date_to);
    if (query.after) {
      to = Date.parse((JSON.parse(Buffer.from(query.after, "base64").toString()) as { timestamp: string }).timestamp);
    }
    const from = Date.parse(query.dateRange.date_from);
    const matching = lines
      .filter((item) => !query.severityLevels?.length || query.severityLevels.includes(item.severity_text ?? ""))
      .filter((item) => Date.parse(item.timestamp) >= from && Date.parse(item.timestamp) <= to)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const results = matching.slice(0, query.limit);
    const hasMore = matching.length > query.limit;
    const last = results.at(-1);
    return Response.json({
      hasMore,
      nextCursor: hasMore && last
        ? Buffer.from(JSON.stringify({ timestamp: last.timestamp, uuid: last.uuid })).toString("base64")
        : null,
      results,
    });
  });
  return { fetch: fetchFn, queries };
}

describe("readPostHogErrorWindow", () => {
  it("pages back from the end and returns the window's error lines oldest first", async () => {
    const lines = Array.from({ length: 2_500 }, (_, index) =>
      line(new Date(Date.parse("2026-11-16T09:55:00Z") + index * 10).toISOString(), `line ${index}`));
    const api = posthog(lines);

    const result = await readPostHogErrorWindow({
      accessToken: "token",
      end: "2026-11-16T09:59:00.000Z",
      fetch: api.fetch,
      host: "https://eu.posthog.com",
      projectId: "12345",
      start: "2026-11-16T09:55:00.000Z",
    });

    expect(result.truncated).toBe(false);
    // The line exactly at the start was read by the previous pull. Pages
    // share the line at their edge, and it is kept once.
    expect(result.lines).toHaveLength(2_499);
    expect(new Set(result.lines.map((item) => item.uuid)).size).toBe(2_499);
    expect(result.lines[0]?.body).toBe("line 1");
    expect(result.lines.at(-1)?.body).toBe("line 2499");
    expect(api.queries[0]).toEqual({
      path: "/api/projects/12345/logs/query/",
      query: {
        dateRange: { date_from: "2026-11-16T09:55:00.000Z", date_to: "2026-11-16T09:59:00.000Z" },
        limit: 1_000,
        orderBy: "latest",
        severityLevels: ["error", "fatal"],
      },
    });
    expect(api.queries[1]?.query.after).toBeTruthy();
  });

  it("keeps the newest lines of a window too large to read", async () => {
    const lines = Array.from({ length: 12_000 }, (_, index) =>
      line(new Date(Date.parse("2026-11-16T09:50:00Z") + index * 10).toISOString(), `line ${index}`));
    const result = await readPostHogErrorWindow({
      accessToken: "token",
      end: "2026-11-16T09:59:00.000Z",
      fetch: posthog(lines).fetch,
      host: "https://eu.posthog.com",
      projectId: "12345",
      start: "2026-11-16T09:50:00.000Z",
    });
    expect(result.truncated).toBe(true);
    expect(result.lines.at(-1)?.body).toBe("line 11999");
  });
});

describe("pullPostHogSource", () => {
  it("sends a new source's error lines from five minutes back and moves the cursor", async () => {
    const api = posthog([
      line("2026-11-16T09:54:00.000Z", "too old"),
      line("2026-11-16T09:57:00.000Z", "payment failed"),
      line("2026-11-16T09:57:30.000Z", "request handled", "info"),
      line("2026-11-16T09:59:30.000Z", "not visible yet"),
    ]);
    const sent: OtlpLogsRequest[] = [];
    const result = await pullPostHogSource({
      accessToken: "token",
      fetch: api.fetch,
      forward: async (payload) => { sent.push(payload); return true; },
      now,
      projectId: "12345",
      state: { host: "https://eu.posthog.com", projectName: "Web app" },
    });

    expect(result).toEqual({
      error: null,
      logs: 1,
      received: true,
      state: { host: "https://eu.posthog.com", logsCursor: "2026-11-16T09:59:00.000Z", projectName: "Web app" },
      truncated: false,
    });
    const records = sent.flatMap((request) => request.resourceLogs.flatMap((resource) => resource.scopeLogs.flatMap((scope) => scope.logRecords)));
    expect(records.map((record) => record.body)).toEqual([{ stringValue: "payment failed" }]);
  });

  it("finds the account's region when the source does not know it", async () => {
    const api = posthog([line("2026-11-16T09:57:00.000Z")], { home: "us" });
    const result = await pullPostHogSource({
      accessToken: "token",
      fetch: api.fetch,
      forward: async () => true,
      now,
      projectId: "12345",
      state: {},
    });
    expect(result.error).toBeNull();
    expect(result.state.host).toBe("https://us.posthog.com");
  });

  it("counts a project without errors as sending logs, checked every ten minutes", async () => {
    const api = posthog([
      line("2026-11-16T09:55:00.000Z", "request handled", "info"),
      line("2026-11-16T10:08:00.000Z", "request handled", "info"),
    ]);
    const pull = (state: Record<string, unknown>, at: Date) => pullPostHogSource({
      accessToken: "token",
      fetch: api.fetch,
      forward: async () => true,
      now: at,
      projectId: "12345",
      state,
    });

    const first = await pull({ host: "https://eu.posthog.com" }, now);
    expect(first.received).toBe(true);
    expect(first.logs).toBe(0);
    expect(api.queries.at(-1)?.query).toEqual(expect.objectContaining({ excludeAttributes: true, limit: 1 }));

    const queries = api.queries.length;
    const second = await pull(first.state, new Date(now.getTime() + 60_000));
    expect(second.received).toBe(false);
    // Only the error read; activity waits ten minutes.
    expect(api.queries.length).toBe(queries + 1);

    const third = await pull(second.state, new Date(now.getTime() + 10 * 60_000));
    expect(third.received).toBe(true);
  });

  it("keeps the cursor when ingest refuses the lines, and reports the error", async () => {
    const api = posthog([line("2026-11-16T09:57:00.000Z")]);
    const state = { host: "https://eu.posthog.com" as const, logsCursor: "2026-11-16T09:58:00.000Z" };
    const refused = await pullPostHogSource({
      accessToken: "token",
      fetch: posthog([line("2026-11-16T09:58:30.000Z")]).fetch,
      forward: async () => false,
      now,
      projectId: "12345",
      state,
    });
    expect(refused).toEqual(expect.objectContaining({ error: "Logs: Telemetry ingest did not accept the logs", received: false, state }));

    const denied = await pullPostHogSource({
      accessToken: "token",
      fetch: api.fetch,
      forward: async () => true,
      now,
      projectId: "12345",
      state: { host: "https://us.posthog.com" },
    });
    expect(denied.error).toBe("Logs: PostHog API request failed (HTTP 401): Invalid token");
    expect(denied.state).toEqual({ host: "https://us.posthog.com" });
  });

  it("skips ahead after an hour behind rather than replaying it", async () => {
    const api = posthog([]);
    await pullPostHogSource({
      accessToken: "token",
      fetch: api.fetch,
      forward: async () => true,
      now,
      projectId: "12345",
      state: { host: "https://eu.posthog.com", logsCursor: "2026-11-16T06:00:00.000Z" },
    });
    expect(api.queries[0]?.query.dateRange.date_from).toBe("2026-11-16T09:00:00.000Z");
  });
});
