import { describe, expect, it } from "vitest";
import {
  environmentFilter,
  formatDuration,
  histogramBars,
  levelSeries,
  logApiParams,
  logExplorerParams,
  logExplorerQuery,
  logTimestamp,
  severityTextTone,
  severityTone,
  spanKindLabel,
  spanStatus,
  spanWaterfall,
  traceApiParams,
  traceHref,
  traceExplorerParams,
  traceExplorerQuery,
  traceListHref,
  withEnvironment,
  type Span,
} from "./telemetry-api";

function span(id: string, parent: string, startMs: number, durationMs: number): Span {
  return {
    duration_ms: durationMs,
    exception_message: "",
    exception_stacktrace: "",
    exception_type: "",
    parent_span_id: parent,
    resource_attrs: {},
    service: "api",
    span_attrs: {},
    span_id: id,
    span_kind: "SPAN_KIND_SERVER",
    span_name: id,
    start_ns: String(1_700_000_000_000_000_000n + BigInt(startMs * 1_000_000)),
    status_code: "STATUS_CODE_UNSET",
    status_message: "",
    timestamp: "",
    trace_id: "t",
  };
}

describe("explorer queries", () => {
  it("reads a log explorer query from the URL and writes it back", () => {
    const params = new URLSearchParams(
      "range=6h&search=timeout&service=api&service=api&severity=error&severity=WARN" +
        "&filter=log.http.route%3D%2Fcheckout&filter=resource.deployment.environment!%3Dstaging&filter=bad&facet=log.http.route",
    );
    const query = logExplorerQuery(params);

    expect(query).toEqual({
      facets: ["log.http.route"],
      filters: [
        { key: "log.http.route", op: "eq", value: "/checkout" },
        { key: "resource.deployment.environment", op: "neq", value: "staging" },
      ],
      range: { kind: "relative", minutes: 360 },
      search: "timeout",
      services: ["api"],
      severities: ["ERROR", "WARN"],
    });
    expect(logExplorerParams(query).toString()).toBe(
      "range=6h&search=timeout&service=api&severity=ERROR&severity=WARN" +
        "&filter=log.http.route%3D%2Fcheckout&filter=resource.deployment.environment%21%3Dstaging&facet=log.http.route",
    );
    expect(logApiParams(query).has("facet")).toBe(false);
  });

  it("keeps a fixed log window in the URL and sends the API its bounds", () => {
    const query = logExplorerQuery(new URLSearchParams(
      "from=2026-10-14T13:00:00.000Z&to=2026-10-14T14:00:00.000Z&severity=error",
    ));

    expect(logExplorerParams(query).toString()).toBe(
      "from=2026-10-14T13%3A00%3A00.000Z&to=2026-10-14T14%3A00%3A00.000Z&severity=ERROR",
    );
    expect(logApiParams(query).toString()).toBe(
      "severity=ERROR&since=2026-10-14T13%3A00%3A00.000Z&until=2026-10-14T14%3A00%3A00.000Z",
    );
  });

  it("resolves a log range that ends now when the request is made", () => {
    const now = Date.parse("2026-10-14T14:00:00.000Z");
    const query = logExplorerQuery(new URLSearchParams("range=30m"));

    expect(logApiParams(query, now).toString()).toBe(
      "since=2026-10-14T13%3A30%3A00.000Z&until=2026-10-14T14%3A00%3A00.000Z",
    );
  });

  it("reads the trace list's older status links and ignores unknown ranges", () => {
    const query = traceExplorerQuery(
      new URLSearchParams("range=90d&status=error&minDurationMs=-5&operation=GET&facet=span.http.route"),
    );

    expect(query).toMatchObject({ minDurationMs: 0, operations: ["GET"], range: "1h", statuses: ["STATUS_CODE_ERROR"] });
    expect(traceExplorerParams({ ...query, minDurationMs: 500 }).toString()).toBe(
      "range=1h&operation=GET&status=STATUS_CODE_ERROR&minDurationMs=500&facet=span.http.route",
    );
    expect(traceApiParams(query).toString()).toBe("range=1h&operation=GET&status=STATUS_CODE_ERROR");
  });

  it("sets and clears the environment filter", () => {
    const filters = withEnvironment([{ key: "log.a", op: "eq", value: "1" }], "production");

    expect(environmentFilter(filters)).toBe("production");
    expect(withEnvironment(filters, "")).toEqual([{ key: "log.a", op: "eq", value: "1" }]);
  });

  it("fills empty buckets and sorts groups into series", () => {
    const bars = histogramBars(
      {
        buckets: [
          { bucket: "2026-10-13 11:00:30", count: 2, group: "ERROR" },
          { bucket: "2026-10-13 11:00:30", count: 5, group: "INFO" },
          { bucket: "2026-10-13 11:01:30", count: 1, group: "WARN" },
        ],
        since: "2026-10-13T11:00:10.000Z",
        stepMs: 30_000,
        until: "2026-10-13T11:01:40.000Z",
      },
      ["error", "warn", "other"] as const,
      levelSeries,
    );

    expect(bars.map((bar) => bar.total)).toEqual([0, 7, 0, 1]);
    expect(bars[1]).toMatchObject({ counts: { error: 2, other: 5, warn: 0 } });
    expect(bars[0]!.start.toISOString()).toBe("2026-10-13T11:00:00.000Z");
  });
});

describe("logTimestamp", () => {
  it("reads a ClickHouse timestamp as UTC", () => {
    expect(logTimestamp("2026-10-13 15:04:05.123456789")?.toISOString()).toBe("2026-10-13T15:04:05.123Z");
    expect(logTimestamp("2026-10-13 15:04:05")?.toISOString()).toBe("2026-10-13T15:04:05.000Z");
  });

  it("rejects other formats", () => {
    expect(logTimestamp("yesterday")).toBeNull();
  });
});

describe("severityTone", () => {
  it("follows OpenTelemetry severity ranges", () => {
    expect(severityTone(5)).toBe("neutral");
    expect(severityTone(9)).toBe("info");
    expect(severityTone(13)).toBe("warning");
    expect(severityTone(17)).toBe("danger");
    expect(severityTone(21)).toBe("danger");
  });
});

describe("severityTextTone", () => {
  it("reads common severity spellings", () => {
    expect(severityTextTone("error")).toBe("danger");
    expect(severityTextTone("CRITICAL")).toBe("danger");
    expect(severityTextTone("Warning")).toBe("warning");
    expect(severityTextTone("INFO")).toBe("info");
    expect(severityTextTone("")).toBe("neutral");
  });
});

describe("spans", () => {
  it("labels status codes and kinds", () => {
    expect(spanStatus("STATUS_CODE_ERROR")).toEqual({ label: "Error", tone: "danger" });
    expect(spanStatus("STATUS_CODE_UNSET").label).toBe("Unset");
    expect(spanKindLabel("SPAN_KIND_SERVER")).toBe("Server");
    expect(spanKindLabel("")).toBe("—");
  });

  it("links to a trace", () => {
    expect(traceHref("abc")).toBe("/traces/abc");
  });

  it("returns from a trace to the list that opened it", () => {
    expect(traceListHref({ traceList: "status=error&range=6h" })).toBe("/traces/search?status=error&range=6h");
    expect(traceListHref({ traceList: "" })).toBe("/traces/search");
    expect(traceListHref(null)).toBe("/traces/search");
    expect(traceListHref({ other: 1 })).toBe("/traces/search");
  });
});

describe("formatDuration", () => {
  it("picks a readable unit", () => {
    expect(formatDuration(0.25)).toBe("250 µs");
    expect(formatDuration(42.123)).toBe("42.1 ms");
    expect(formatDuration(1234)).toBe("1.23 s");
    expect(formatDuration(125_000)).toBe("2 m 5 s");
    expect(formatDuration(119_600)).toBe("2 m 0 s");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});

describe("spanWaterfall", () => {
  it("orders spans as a tree and places them on the trace timeline", () => {
    const { durationMs, rows } = spanWaterfall([
      span("db", "handler", 30, 20),
      span("root", "", 0, 100),
      span("auth", "handler", 10, 10),
      span("handler", "root", 5, 90),
    ]);

    expect(rows.map((row) => [row.span.span_id, row.depth])).toEqual([
      ["root", 0],
      ["handler", 1],
      ["auth", 2],
      ["db", 2],
    ]);
    expect(rows[3]).toMatchObject({ offset: 30, width: 20 });
    expect(durationMs).toBe(100);
  });

  it("starts a new tree for a span whose parent is missing, and keeps spans in a cycle", () => {
    const { rows } = spanWaterfall([
      span("orphan", "gone", 50, 10),
      span("a", "b", 0, 5),
      span("b", "a", 1, 5),
    ]);

    expect(rows.map((row) => row.span.span_id).sort()).toEqual(["a", "b", "orphan"]);
    expect(rows.find((row) => row.span.span_id === "orphan")?.depth).toBe(0);
  });

  it("handles an empty trace", () => {
    expect(spanWaterfall([])).toEqual({ durationMs: 0, rows: [] });
  });
});
