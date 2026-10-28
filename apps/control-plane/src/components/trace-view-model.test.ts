import { describe, expect, it } from "vitest";
import { spanWaterfall, type Span } from "../telemetry-api";
import { traceAttributeScopes, traceRequest, traceServiceColors, visibleTraceRows } from "./trace-view-model";

function span(id: string, parent = "", attrs: Record<string, string> = {}): Span {
  return { span_id: id, parent_span_id: parent, span_name: id, trace_id: "trace", service: parent ? "database" : "api", start_ns: "1000000000", duration_ms: 100, timestamp: "2026-10-28T12:00:00Z", span_kind: "SPAN_KIND_INTERNAL", status_code: "STATUS_CODE_OK", status_message: "", exception_type: "", exception_message: "", exception_stacktrace: "", span_attrs: attrs, resource_attrs: {} };
}
const ids = (rows: ReturnType<typeof spanWaterfall>["rows"]) => rows.map((row) => row.span.span_id);

describe("trace visibility", () => {
  const rows = spanWaterfall([span("root"), span("child", "root"), span("leaf", "child", { "db.query": "SELECT orders" }), span("sibling", "root"), span("orphan", "missing")]).rows;
  it("collapses descendants while retaining siblings and disconnected roots", () => {
    expect(ids(visibleTraceRows(rows, new Set(["child"]), ""))).toEqual(["root", "child", "sibling", "orphan"]);
    expect(ids(visibleTraceRows(rows, new Set(["root"]), ""))).toEqual(["root", "orphan"]);
  });
  it("reveals a search match and its ancestors inside collapsed branches", () => {
    expect(ids(visibleTraceRows(rows, new Set(["root"]), "select orders"))).toEqual(["root", "child", "leaf"]);
    expect(visibleTraceRows(rows, new Set(), "missing-value")).toEqual([]);
  });
  it("keeps context for errors and intersects error and text filters", () => {
    const failures = rows.map((row) => row.span.span_id === "leaf" ? { ...row, span: { ...row.span, status_code: "STATUS_CODE_ERROR" } } : row);
    expect(ids(visibleTraceRows(failures, new Set(["root"]), "", true))).toEqual(["root", "child", "leaf"]);
    expect(visibleTraceRows(failures, new Set(), "sibling", true)).toEqual([]);
  });
  it("assigns the reference colors by service, not individual span", () => {
    const colors = traceServiceColors(rows);
    expect(colors.get("api")).toBe("#3b8ff5");
    expect(colors.get("database")).toBe("#8b50f5");
    expect(colors.size).toBe(2);
  });
});

describe("trace inspector", () => {
  it("supports both HTTP semantic conventions and preserves non-HTTP names", () => {
    expect(traceRequest(span("GET /orders", "", { "http.request.method": "GET", "url.full": "https://example.com/orders?secret=value", "http.response.status_code": "200" }))).toEqual({ method: "GET", name: "/orders", status: 200 });
    expect(traceRequest(span("GET /orders", "", { "http.method": "GET", "http.url": "malformed", "http.status_code": "bad" }))).toEqual({ method: "GET", name: "/orders", status: null });
    expect(traceRequest(span("worker.process"))).toEqual({ method: "", name: "worker.process", status: null });
  });
  it("separates display groups while retaining the real filter namespace", () => {
    const groups = traceAttributeScopes(span("root", "", { "http.route": "/orders", "request.id": "123" }));
    expect(groups.map(({ id, prefix }) => [id, prefix])).toEqual([["http", "span."], ["context", "span."], ["resource", "resource."]]);
    expect(groups[0]!.values).toEqual({ "http.route": "/orders" });
    expect(groups[1]!.values).toEqual({ "request.id": "123" });
    expect(groups[1]!.defaultCollapsed).toBe(true);
  });
});
