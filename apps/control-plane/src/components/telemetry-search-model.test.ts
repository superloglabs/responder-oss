import { describe, expect, it } from "vitest";
import { logExplorerParams, logExplorerQuery, traceExplorerParams, traceSearchQuery } from "../telemetry-api";
import { durationMs, parseSearchDraft, queryWithTokens, searchFields, searchTokens } from "./telemetry-search-model";

describe("telemetry search query mapping", () => {
  it("preserves scoped keys, time windows, sidebar state and OR values across URL round trips", () => {
    const query = logExplorerQuery(new URLSearchParams("from=2026-10-01T00%3A00%3A00Z&to=2026-10-02T00%3A00%3A00Z&service=api&service=worker&severity=ERROR&filter=log.region%3Dus&filter=resource.region!%3Deu&search=failed&facet=log.region"));
    const next = queryWithTokens(query, searchTokens(query));
    expect(logExplorerQuery(logExplorerParams(next))).toEqual(query);
    expect(next.filters).toEqual([{ key: "log.region", op: "eq", value: "us" }, { key: "resource.region", op: "neq", value: "eu" }]);
  });

  it("edits a token atomically without dropping other facets", () => {
    const query = logExplorerQuery(new URLSearchParams("service=api&severity=ERROR&search=timeout"));
    const tokens = searchTokens(query).map(t => t.key === "service" ? { ...t, value: "worker" } : t);
    expect(queryWithTokens(query, tokens)).toMatchObject({ services: ["worker"], severities: ["ERROR"], search: "timeout" });
    expect(query.services).toEqual(["api"]);
    expect(queryWithTokens(query, [])).toMatchObject({ services: [], severities: [], search: "", filters: [] });
  });

  it("preserves trace status, operation and minimum duration through the URL", () => {
    const query = traceSearchQuery(new URLSearchParams("status=STATUS_CODE_ERROR&operation=POST+%2Fapi&minDurationMs=500&filter=span.http.route%3D%2Fcheckout"));
    expect(traceSearchQuery(traceExplorerParams(queryWithTokens(query, searchTokens(query))))).toEqual(query);
    expect(queryWithTokens(query, [{ id: "d", key: "duration", op: ">=", value: "1.5s" }]).minDurationMs).toBe(1500);
  });

  it("deduplicates a repeated filter and retains empty attribute values", () => {
    const query = logExplorerQuery(new URLSearchParams());
    const token = { id: "a", key: "log.error", op: "=" as const, value: "" };
    expect(queryWithTokens(query, [token, { ...token, id: "b" }]).filters).toEqual([{ key: "log.error", op: "eq", value: "" }]);
  });
});

describe("attribute and value discovery", () => {
  const fields = searchFields("logs", ["resource.service.name", "resource.region", "log.region", "resource.region"]);
  it("deduplicates the service alias without merging different attribute scopes", () => {
    expect(fields.filter(f => f.label === "service.name")).toHaveLength(1);
    expect(fields.filter(f => f.label === "region").map(f => f.key)).toEqual(["resource.region", "log.region"]);
  });
  it("parses typed aliases, exclusion, and quoted values without losing equals signs", () => {
    expect(parseSearchDraft('service.name="worker"', fields)).toMatchObject({ field: { key: "service" }, op: "=", value: "worker" });
    expect(parseSearchDraft('log.region!="x=y"', fields)).toMatchObject({ field: { key: "log.region" }, op: "!=", value: "x=y" });
    expect(parseSearchDraft('service.name>worker', fields)).toBeNull();
    expect(parseSearchDraft('log.new_attribute="hello"', fields)).toMatchObject({ field: { key: "log.new_attribute" }, value: "hello" });
    expect(parseSearchDraft('deployment.environment=production', fields)).toMatchObject({ field: { key: "resource.deployment.environment" } });
  });
  it("offers only supported comparisons for the actual trace-duration query", () => {
    const traceFields = searchFields("traces", []);
    expect(parseSearchDraft("duration>=500ms", traceFields)).toMatchObject({ op: ">=", value: "500ms" });
    expect(parseSearchDraft("duration<500ms", traceFields)).toBeNull();
    expect(parseSearchDraft("duration>500ms", traceFields)).toBeNull();
  });
  it.each([["500ms", 500], ["1.5s", 1500], ["2m", 120000], ["60m", 3600000], ["500", null], ["-1s", null], ["0ms", null], ["61m", null], ["NaNms", null]])("validates duration %s", (value, expected) => {
    expect(durationMs(value as string)).toBe(expected);
  });
});
