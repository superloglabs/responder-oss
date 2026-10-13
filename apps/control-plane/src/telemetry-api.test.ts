import { describe, expect, it } from "vitest";
import {
  formatDuration,
  logSearchParams,
  logTimestamp,
  severityTextTone,
  severityTone,
  spanKindLabel,
  spanStatus,
  spanWaterfall,
  traceHref,
  traceSearchParams,
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

describe("logSearchParams", () => {
  it("sends only the filters that are set", () => {
    expect(
      logSearchParams({
        projectId: "11111111-1111-4111-8111-111111111111",
        range: "6h",
        search: "  timeout ",
        service: "",
        severity: "ERROR",
      }).toString(),
    ).toBe("projectId=11111111-1111-4111-8111-111111111111&range=6h&search=timeout&severity=ERROR");
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

  it("links to a trace in its project", () => {
    expect(traceHref("p-1", "abc")).toBe("/traces/abc?projectId=p-1");
  });
});

describe("traceSearchParams", () => {
  it("sends only the filters that are set", () => {
    expect(
      traceSearchParams({
        minDurationMs: 0,
        projectId: "p",
        range: "1h",
        service: "checkout",
        status: "",
      }).toString(),
    ).toBe("projectId=p&range=1h&service=checkout");
    expect(
      traceSearchParams({ minDurationMs: 500, projectId: "p", range: "7d", service: "", status: "error" }).toString(),
    ).toBe("projectId=p&range=7d&status=error&minDurationMs=500");
  });
});

describe("formatDuration", () => {
  it("picks a readable unit", () => {
    expect(formatDuration(0.25)).toBe("250 µs");
    expect(formatDuration(42.123)).toBe("42.1 ms");
    expect(formatDuration(1234)).toBe("1.23 s");
    expect(formatDuration(125_000)).toBe("2 m 5 s");
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
