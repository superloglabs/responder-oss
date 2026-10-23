import { describe, expect, it } from "vitest";
import { readErrorFilters } from "./error-filter-state";
import { errorActivity, errorIssueParams } from "./error-issues-api";

describe("error catalog filters", () => {
  it("defaults to unresolved but respects an explicitly cleared status", () => {
    expect(readErrorFilters(new URLSearchParams()).status).toEqual(["open"]);
    expect(readErrorFilters(new URLSearchParams("status=all")).status).toEqual([]);
  });
  it("preserves multiple service names including commas and combines independent properties", () => {
    const params = errorIssueParams({ status: "all", statuses: ["open", "resolved"], services: ["api,eu", "worker"], environments: ["production"], activity: "inactive", range: "7d", search: " invoice " });
    expect(params.getAll("statuses")).toEqual(["open", "resolved"]);
    expect(params.getAll("services")).toEqual(["api,eu", "worker"]);
    expect(params.getAll("environments")).toEqual(["production"]);
    expect(params.get("activity")).toBe("inactive");
    expect(params.get("range")).toBe("7d");
    expect(params.get("search")).toBe("invoice");
  });
  it("keeps the 15-minute boundary consistent with the server", () => {
    const now = Date.parse("2026-10-23T12:00:00Z");
    expect(errorActivity("2026-10-23T11:45:00Z", now)).toBe("active");
    expect(errorActivity("2026-10-23T11:44:59.999Z", now)).toBe("inactive");
  });
});
