import { describe, expect, it } from "vitest";
import {
  describeSyntheticAssertion,
  evaluateSyntheticAssertions,
  jsonPathSegments,
  syntheticFailureReason,
  syntheticRunStatus,
} from "./assertions.js";
import type { SyntheticAssertion, SyntheticResponse } from "./types.js";

const now = new Date("2026-10-15T12:00:00.000Z");
const response: SyntheticResponse = {
  body: JSON.stringify({ data: { items: [{ id: 7, name: "first" }] }, "odd key": true, status: "ok" }),
  bodyBytes: 80,
  bodyTruncated: false,
  certificateExpiresAt: "2026-11-14T12:00:00.000Z",
  headers: { "content-type": "application/json; charset=utf-8" },
  redirects: 0,
  statusCode: 204,
  url: "https://example.com/health",
};

function check(assertion: Partial<SyntheticAssertion> & Pick<SyntheticAssertion, "kind" | "op">, durationMs = 120) {
  const [result] = evaluateSyntheticAssertions([{ severity: "critical", value: "", ...assertion }], response, durationMs, now);
  return result!;
}

describe("synthetic assertions", () => {
  it("matches status codes exactly, by class and by range", () => {
    expect(check({ kind: "status_code", op: "eq", value: "2xx" }).passed).toBe(true);
    expect(check({ kind: "status_code", op: "neq", value: "2xx" }).passed).toBe(false);
    expect(check({ kind: "status_code", op: "eq", value: "200" })).toMatchObject({ actual: "204", passed: false });
    expect(check({ kind: "status_code", op: "lt", value: "400" }).passed).toBe(true);
  });

  it("compares the response time in whole milliseconds", () => {
    expect(check({ kind: "response_time", op: "lt", value: "500" }, 499.6).passed).toBe(false);
    expect(check({ kind: "response_time", op: "lt", value: "500" }, 499.4).passed).toBe(true);
  });

  it("reads headers by any case", () => {
    expect(check({ key: "Content-Type", kind: "header", op: "contains", value: "json" }).passed).toBe(true);
    expect(check({ key: "x-missing", kind: "header", op: "not_exists" }).passed).toBe(true);
    expect(check({ key: "x-missing", kind: "header", op: "eq", value: "1" })).toMatchObject({ actual: null, passed: false });
  });

  it("does not show that a cut-off body lacks text", () => {
    expect(check({ kind: "body", op: "contains", value: "first" }).passed).toBe(true);
    expect(check({ kind: "body", op: "not_contains", value: "error" }).passed).toBe(true);
    const [truncated] = evaluateSyntheticAssertions(
      [{ kind: "body", op: "not_contains", severity: "critical", value: "error" }],
      { ...response, bodyTruncated: true },
      1,
      now,
    );
    expect(truncated!.passed).toBe(false);
  });

  it("reads JSON paths, comparing numbers as numbers", () => {
    expect(jsonPathSegments('$.data.items[0]["na\\"me"]')).toEqual(["data", "items", 0, 'na"me']);
    expect(check({ key: "$.status", kind: "json_path", op: "eq", value: "ok" }).passed).toBe(true);
    expect(check({ key: "data.items[0].id", kind: "json_path", op: "eq", value: "7.0" }).passed).toBe(true);
    expect(check({ key: "data.items[0].id", kind: "json_path", op: "gt", value: "5" }).passed).toBe(true);
    expect(check({ key: '$["odd key"]', kind: "json_path", op: "eq", value: "true" }).passed).toBe(true);
    expect(check({ key: "data.items", kind: "json_path", op: "contains", value: '"first"' }).passed).toBe(true);
    expect(check({ key: "data.missing", kind: "json_path", op: "not_exists" }).passed).toBe(true);
    expect(check({ key: "constructor", kind: "json_path", op: "exists" }).passed).toBe(false);
  });

  it("counts whole days until the certificate expires", () => {
    expect(check({ kind: "certificate_expiry", op: "gt", value: "14" })).toMatchObject({ actual: "30", passed: true });
    expect(check({ kind: "certificate_expiry", op: "gt", value: "30" }).passed).toBe(false);
  });

  it("fails every assertion without a response", () => {
    expect(
      evaluateSyntheticAssertions([{ kind: "status_code", op: "eq", severity: "critical", value: "2xx" }], null, 0, now),
    ).toEqual([expect.objectContaining({ passed: false })]);
  });

  it("derives the run status from the error and assertion severities", () => {
    const failing = (severity: SyntheticAssertion["severity"]) => ({
      actual: "503",
      assertion: { kind: "status_code" as const, op: "eq" as const, severity, value: "2xx" },
      passed: false,
    });
    expect(syntheticRunStatus("Timed out", [])).toBe("failed");
    expect(syntheticRunStatus(null, [failing("degraded")])).toBe("degraded");
    expect(syntheticRunStatus(null, [failing("degraded"), failing("critical")])).toBe("failed");
    expect(syntheticRunStatus(null, [])).toBe("passed");
    expect(syntheticFailureReason({ assertions: [failing("degraded"), failing("critical")], error: null })).toBe(
      "Expected status code is 2xx, got 503",
    );
  });

  it("describes assertions", () => {
    expect(describeSyntheticAssertion({ key: "$.status", kind: "json_path", op: "eq", severity: "critical", value: "ok" })).toBe(
      "JSON $.status is ok",
    );
    expect(describeSyntheticAssertion({ kind: "response_time", op: "lt", severity: "degraded", value: "800" })).toBe(
      "Response time is below 800 ms",
    );
  });
});
