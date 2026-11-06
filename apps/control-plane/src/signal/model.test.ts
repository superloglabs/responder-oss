import { describe, expect, it } from "vitest";
import { homePath, navigationOptions, newWorkspacePath, primaryNavigation, settingsInSidebar } from "../primary-navigation";
import { dailyFindings, periodData, sampleFindings } from "./model";

describe("Signal preview", () => {
  it("is absent without its capability and opens setup when enabled", () => {
    expect(primaryNavigation(navigationOptions(["automations", "telemetry"])).some((item) => item.section.startsWith("signal"))).toBe(false);
    expect(homePath(["signal"])).toBe("/signal/setup");
    expect(newWorkspacePath(["signal"])).toBe("/signal/setup");
  });
  it("keeps the Signal navigation isolated even with other capabilities", () => {
    const options = navigationOptions(["signal", "automations", "telemetry", "simplified_navigation"]);
    expect(primaryNavigation(options).map((item) => item.label)).toEqual(["Setup", "Findings", "Usage", "Settings"]);
    expect(settingsInSidebar(options)).toBe(false);
  });
  it("keeps list, daily chart, and whole-period totals consistent", () => {
    expect(sampleFindings).toHaveLength(42);
    expect(sampleFindings.filter((f) => f.accepted)).toHaveLength(27);
    for (const day of dailyFindings) {
      const findings = sampleFindings.filter((f) => f.date.getTime() === day.date.getTime());
      expect(findings).toHaveLength(day.total);
      expect(findings.filter((f) => f.accepted)).toHaveLength(day.accepted);
    }
    expect(new Set(sampleFindings.map((f) => f.id)).size).toBe(42);
  });
  it("includes zero days for the full selected period", () => {
    expect(periodData(30)).toHaveLength(30);
    expect(periodData(30)[0].date.toISOString()).toBe("2026-10-08T00:00:00.000Z");
    expect(periodData(7)).toHaveLength(7);
    expect(periodData(30).reduce((n, p) => n + p.total, 0)).toBe(42);
  });
});
