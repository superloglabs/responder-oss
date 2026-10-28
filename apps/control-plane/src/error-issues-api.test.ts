import { describe, expect, it } from "vitest";
import {
  dailyCounts,
  daysThroughToday,
  errorIssueChart,
  errorIssueDetailChart,
  errorIssueParams,
  formatEventCount,
  hourlyCounts,
  sampleAttributes,
} from "./error-issues-api";

describe("error issue presentation", () => {
  it("fills days without occurrences with zero", () => {
    expect(dailyCounts([
      { day: "2026-10-20", eventCount: 3 },
      { day: "2026-10-22", eventCount: 5 },
      { day: "2026-10-30", eventCount: 9 },
    ], "2026-10-20", 4)).toEqual([3, 0, 5, 0]);
  });

  it("fills hours without occurrences with zero", () => {
    expect(hourlyCounts([
      { eventCount: 2, hour: "2026-10-22T10:00:00.000Z" },
      { eventCount: 7, hour: "2026-10-22T12:00:00.000Z" },
      { eventCount: 9, hour: "2026-10-22T09:00:00.000Z" },
    ], "2026-10-22T10:00:00.000Z", 3)).toEqual([2, 0, 7]);
  });

  it("counts the days through today", () => {
    expect(daysThroughToday("2026-10-09", Date.parse("2026-10-22T12:00:00Z"))).toBe(14);
    expect(daysThroughToday("2026-10-22", Date.parse("2026-10-22T00:00:00Z"))).toBe(1);
  });

  it("charts one bucket per day", () => {
    const chart = errorIssueChart([{ day: "2026-10-21", eventCount: 4 }], "2026-10-20", Date.parse("2026-10-22T12:00:00Z"));

    expect(chart.buckets).toEqual([Date.parse("2026-10-20T00:00:00Z"), Date.parse("2026-10-21T00:00:00Z"), Date.parse("2026-10-22T00:00:00Z")]);
    expect(chart.series[0]?.values).toEqual([0, 4, 0]);
    expect(chart.stepMs).toBe(86_400_000);
  });

  it("shortens large counts", () => {
    expect(formatEventCount(999)).toBe("999");
    expect(formatEventCount(1_000)).toBe("1k");
    expect(formatEventCount(1_250)).toBe("1.3k");
    expect(formatEventCount(48_200)).toBe("48k");
    expect(formatEventCount(2_400_000)).toBe("2.4M");
  });

  it("builds list parameters, trimming the search and paging from the last issue", () => {
    expect(errorIssueParams({ status: "open" }).toString()).toBe("status=open");
    expect(errorIssueParams({
      before: { id: "issue", lastSeenAt: "2026-10-22T11:00:00.000Z" },
      search: "  invoice ",
      service: "api",
      status: "all",
    }).toString()).toBe("status=all&service=api&search=invoice&before=2026-10-22T11%3A00%3A00.000Z&beforeId=issue");
  });

  it("sorts sample attributes by key", () => {
    expect(sampleAttributes({ b: "2", a: "1" })).toEqual([["a", "1"], ["b", "2"]]);
  });
});

it("aggregates real hours into three-hour buckets, including a partial current bucket", () => {
  const chart = errorIssueDetailChart({ since: "2026-10-22", days: [{ day: "2026-10-22", eventCount: 10 }], hours: [
    { hour: "2026-10-22T00:00:00Z", eventCount: 2 },
    { hour: "2026-10-22T02:00:00Z", eventCount: 3 },
    { hour: "2026-10-22T06:00:00Z", eventCount: 5 },
  ] }, Date.parse("2026-10-22T06:30:00Z"));
  expect(chart.stepMs).toBe(10_800_000);
  expect(chart.series[0]?.values).toEqual([5, 0, 5]);
  expect(chart.buckets).toEqual([0, 3, 6].map((hour) => Date.parse("2026-10-22T00:00:00Z") + hour * 3_600_000));
});

it("keeps daily totals when historic hours are missing, even when overall totals match", () => {
  const chart = errorIssueDetailChart({ since: "2026-10-21", days: [{ day: "2026-10-21", eventCount: 5 }], hours: [
    { hour: "2026-10-22T00:00:00Z", eventCount: 5 },
  ] }, Date.parse("2026-10-22T06:30:00Z"));
  expect(chart.stepMs).toBe(86_400_000);
  expect(chart.series[0]?.values).toEqual([5, 0]);
});
