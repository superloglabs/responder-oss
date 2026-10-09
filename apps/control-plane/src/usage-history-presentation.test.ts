import { describe, expect, it } from "vitest";
import {
  formatUsage,
  rankUsageSources,
  usageAxisTicks,
  usageChart,
  type UsageHistory,
} from "./usage-history-presentation";

function history(points: UsageHistory["points"], sourceCount = 0): UsageHistory {
  const sources: UsageHistory["sources"] = {
    tag_mode: { kind: "tag_mode" },
    pull_requests: { kind: "pull_requests" },
  };
  for (let index = 1; index <= sourceCount; index += 1) {
    sources[`automation-${index}`] = { automationId: `automation-${index}`, kind: "automation", name: `Automation ${index}` };
  }
  return { days: ["2026-10-08", "2026-10-09"], points, sources };
}

describe("usageChart", () => {
  it("stacks each day's sources in rank order and keeps empty days", () => {
    const chart = usageChart(history([
      { aiCharge: 1, day: "2026-10-09", machineHours: 2, source: "tag_mode" },
      { aiCharge: 3, day: "2026-10-09", machineHours: 6, source: "automation-1" },
    ], 1), "machineHours");

    expect(chart.series).toEqual([
      { key: "automation-1", label: "Automation 1", slot: 1, total: 6 },
      { key: "tag_mode", label: "Tag mode", slot: 2, total: 2 },
    ]);
    expect(chart.columns).toEqual([
      { day: "2026-10-08", segments: [], total: 0 },
      {
        day: "2026-10-09",
        segments: [{ series: "automation-1", value: 6 }, { series: "tag_mode", value: 2 }],
        total: 8,
      },
    ]);
    expect(chart.total).toBe(8);
  });

  it("keeps each source's color when the metric changes", () => {
    const data = history([
      { aiCharge: 0, day: "2026-10-09", machineHours: 10, source: "automation-1" },
      { aiCharge: 5, day: "2026-10-09", machineHours: 1, source: "tag_mode" },
      { aiCharge: 1, day: "2026-10-09", machineHours: 0, source: "pull_requests" },
    ], 1);

    const slots = (metric: "aiCharge" | "machineHours") =>
      Object.fromEntries(usageChart(data, metric).series.map((series) => [series.key, series.slot]));

    expect(slots("aiCharge")).toEqual(slots("machineHours"));
    expect(rankUsageSources(data)).toEqual(["tag_mode", "automation-1", "pull_requests"]);
  });

  it("folds sources past the color slots into Other", () => {
    const points = Array.from({ length: 10 }, (_, index) => ({
      aiCharge: 10 - index,
      day: "2026-10-09",
      machineHours: 10 - index,
      source: `automation-${index + 1}`,
    }));

    const chart = usageChart(history(points, 10), "aiCharge");

    expect(chart.series.map((series) => series.label)).toEqual([
      "Automation 1",
      "Automation 2",
      "Automation 3",
      "Automation 4",
      "Automation 5",
      "Automation 6",
      "Automation 7",
      "Other",
    ]);
    expect(chart.series.at(-1)).toMatchObject({ slot: 8, total: 3 + 2 + 1 });
    expect(chart.columns[1]?.total).toBe(55);
  });
});

describe("usage formatting", () => {
  it("picks round axis steps that cover the tallest day", () => {
    expect(usageAxisTicks(0)).toEqual([0]);
    expect(usageAxisTicks(7.3)).toEqual([0, 2, 4, 6, 8]);
    expect(usageAxisTicks(1.6)).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(usageAxisTicks(3.4)).toEqual([0, 1, 2, 3, 4]);
  });

  it("shows minutes for short sandbox time and cents for model usage", () => {
    expect(formatUsage("machineHours", 0.05)).toBe("3 min");
    expect(formatUsage("machineHours", 13.94)).toBe("13.9 h");
    expect(formatUsage("aiCharge", 0.004)).toBe("<$0.01");
    expect(formatUsage("aiCharge", 15.5)).toBe("$15.50");
  });
});
