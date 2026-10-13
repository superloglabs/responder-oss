import { describe, expect, it } from "vitest";
import { logSearchParams, logTimestamp, severityTone } from "./logs-api";

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
