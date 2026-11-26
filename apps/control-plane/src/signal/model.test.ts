import { describe, expect, it } from "vitest";
import { chartMax, dayLabel, evidenceAxisLabel, evidenceAxisMax, evidenceAxisRange, evidenceBucketLabel, evidenceChartBars, evidenceLegendValue, evidenceLink, foundLabel, groupFindingsByDay, usageTotals } from "./model";
import { setupComplete } from "./setup-state";

const now = new Date("2026-11-07T15:00:00Z");

describe("Signal presentation", () => {
  it("labels when a finding was found", () => {
    expect(foundLabel(new Date("2026-11-07T14:59:40Z"), now)).toBe("Just now");
    expect(foundLabel(new Date("2026-11-07T14:52:00Z"), now)).toBe("8m ago");
    expect(foundLabel(new Date("2026-11-07T12:10:00Z"), now)).toBe("2h ago");
    expect(foundLabel(new Date("2026-11-06T23:00:00Z"), now)).toBe("Yesterday");
    expect(foundLabel(new Date("2026-10-30T10:00:00Z"), now)).toBe("30 Oct");
  });

  it("groups findings by the day they were posted, keeping their order", () => {
    const groups = groupFindingsByDay([
      { id: "a", postedAt: "2026-11-07T14:00:00Z" },
      { id: "b", postedAt: "2026-11-07T09:00:00Z" },
      { id: "c", postedAt: "2026-11-06T09:00:00Z" },
      { id: "d", postedAt: "2026-11-02T09:00:00Z" },
    ], now);
    expect(groups.map((group) => [group.label, group.findings.map((finding) => finding.id)])).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      ["2 Nov", ["d"]],
    ]);
    expect(dayLabel(new Date("2026-11-07T00:00:00Z"), now)).toBe("Today");
  });

  it("totals usage and its accepted share", () => {
    expect(usageTotals([
      { date: "2026-11-06", total: 3, accepted: 1 },
      { date: "2026-11-07", total: 1, accepted: 1 },
    ])).toEqual({ total: 4, accepted: 2, acceptedPercent: 50 });
    expect(usageTotals([]).acceptedPercent).toBe(0);
  });

  it("rounds the chart scale up to a multiple of three", () => {
    expect(chartMax([0, 0])).toBe(3);
    expect(chartMax([1, 2])).toBe(3);
    expect(chartMax([4, 7])).toBe(9);
  });
});

describe("Signal setup", () => {
  it("is complete once Signal has been turned on, even if it is off now", () => {
    expect(setupComplete({ enabled: false, setupComplete: false })).toBe(false);
    expect(setupComplete({ enabled: false, setupComplete: true })).toBe(true);
    expect(setupComplete({ enabled: true })).toBe(true);
    expect(setupComplete({ enabled: false })).toBe(false);
  });
});

describe("evidenceLink", () => {
  it("keeps app paths and https links only", () => {
    expect(evidenceLink("/logs?from=x")).toEqual({ internal: true, href: "/logs?from=x" });
    expect(evidenceLink("https://ui.honeycomb.io/team/result/abc")).toEqual({ internal: false, href: "https://ui.honeycomb.io/team/result/abc" });
    expect(evidenceLink("//evil.example/x")).toBeNull();
    expect(evidenceLink("/\\evil.example/x")).toBeNull();
    expect(evidenceLink("/logs\tx")).toBeNull();
    expect(evidenceLink("javascript:alert(1)")).toBeNull();
    expect(evidenceLink("http://ui.honeycomb.io/x")).toBeNull();
    expect(evidenceLink(null)).toBeNull();
  });
});

describe("evidence charts", () => {
  it("rounds the axis to three even steps", () => {
    expect(evidenceAxisMax([5])).toBe(6);
    expect(evidenceAxisMax([17_280])).toBe(30_000);
    expect(evidenceAxisMax([29_600])).toBe(30_000);
    expect(evidenceAxisMax([0.4])).toBe(0.6);
    expect(evidenceAxisMax([null, 0])).toBe(3);
  });

  it("extends the axis below zero for negative values", () => {
    expect(evidenceAxisRange([5])).toEqual({ min: 0, max: 6 });
    expect(evidenceAxisRange([-4, 5])).toEqual({ min: -5, max: 10 });
    expect(evidenceAxisRange([-30, -10])).toEqual({ min: -30, max: 0 });
    expect(evidenceAxisRange([null])).toEqual({ min: 0, max: 3 });
  });

  it("labels the axis briefly", () => {
    expect(evidenceAxisLabel(20_000, "none")).toBe("20K");
    expect(evidenceAxisLabel(20_000, "duration_ms")).toBe("20s");
    expect(evidenceAxisLabel(250, "duration_ms")).toBe("250ms");
    expect(evidenceAxisLabel(0, "duration_ms")).toBe("0s");
    expect(evidenceAxisLabel(2048, "bytes")).toBe("2KB");
  });

  it("names the bucket size", () => {
    expect(evidenceBucketLabel(600_000)).toBe("10-minute buckets");
    expect(evidenceBucketLabel(3_600_000)).toBe("1-hour buckets");
    expect(evidenceBucketLabel(90_000)).toBe("90-second buckets");
  });

  it("draws one series of counts as bars, totalled", () => {
    const view = { type: "chart" as const, title: "c", unit: "none" as const, buckets: [1, 2], stepMs: 1, series: [{ name: "a", values: [1, null, 4] }] };
    expect(evidenceChartBars(view)).toBe(true);
    expect(evidenceChartBars({ ...view, series: [{ name: "a", values: [1.5] }] })).toBe(false);
    expect(evidenceChartBars({ ...view, unit: "duration_ms" })).toBe(false);
    expect(evidenceLegendValue([1, null, 4], true)).toBe(5);
    expect(evidenceLegendValue([1, null, 4], false)).toBe(4);
  });
});
