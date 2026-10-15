import { describe, expect, it } from "vitest";
import { sourceHealth } from "./telemetry-sources-api";

const now = Date.parse("2026-10-15T10:00:00Z");

describe("sourceHealth", () => {
  it("reports data from the last fifteen minutes as receiving", () => {
    expect(sourceHealth({ lastError: null, lastReceivedAt: "2026-10-15T09:50:00Z", status: "active" }, now)).toEqual({ label: "Receiving", tone: "live" });
    expect(sourceHealth({ lastError: "Metrics: denied", lastReceivedAt: "2026-10-15T09:50:00Z", status: "active" }, now).tone).toBe("warning");
  });

  it("tells waiting, stale and failed sources apart", () => {
    expect(sourceHealth({ lastError: null, lastReceivedAt: null, status: "pending" }, now).label).toBe("Waiting for data");
    expect(sourceHealth({ lastError: null, lastReceivedAt: "2026-10-15T08:00:00Z", status: "active" }, now).label).toBe("No recent data");
    expect(sourceHealth({ lastError: "Logs: denied", lastReceivedAt: null, status: "failed" }, now)).toEqual({ label: "Error", tone: "danger" });
  });
});
