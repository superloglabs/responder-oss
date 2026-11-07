import { describe, expect, it } from "vitest";
import { chartMax, dayLabel, foundLabel, groupFindingsByDay, usageTotals } from "./model";
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
