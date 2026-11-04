import { describe, expect, it } from "vitest";
import { telemetryWindow } from "./reads.js";

describe("telemetryWindow", () => {
  const now = new Date("2026-10-16T10:00:00.000Z");

  it("reads back from now, or from an explicit start", () => {
    expect(telemetryWindow({ range: "1h" }, now)).toEqual({
      since: "2026-10-16T09:00:00.000Z",
      until: "2026-10-16T10:00:00.000Z",
    });
    expect(telemetryWindow({ range: "1h", since: "2026-10-01T00:00:00+02:00" }, now)).toEqual({
      since: "2026-09-30T22:00:00.000Z",
      until: "2026-10-16T10:00:00.000Z",
    });
    expect(telemetryWindow({ range: "15m", until: "2026-10-15T12:00:00Z" }, now)).toEqual({
      since: "2026-10-15T11:45:00.000Z",
      until: "2026-10-15T12:00:00.000Z",
    });
  });

  it("rejects backwards windows and windows over 30 days", () => {
    expect(() => telemetryWindow({ range: "1h", since: "2026-10-16T11:00:00Z" }, now))
      .toThrow("`since` must be before `until`.");
    expect(() => telemetryWindow({ range: "1h", since: "2026-09-01T00:00:00Z" }, now))
      .toThrow("The window can be at most 30 days.");
  });
});
