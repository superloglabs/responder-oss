import { describe, expect, it } from "vitest";
import { usagePlanLabel, usageResetLabel, usageWindowLabel } from "./subscription-usage-presentation";

describe("usageWindowLabel", () => {
  it("names the windows ChatGPT reports", () => {
    expect(usageWindowLabel(300)).toBe("5-hour limit");
    expect(usageWindowLabel(10_080)).toBe("Weekly limit");
    expect(usageWindowLabel(2_880)).toBe("2-day limit");
    expect(usageWindowLabel(90)).toBe("90-minute limit");
    expect(usageWindowLabel(null)).toBe("Usage limit");
  });
});

describe("usageResetLabel", () => {
  const now = Date.UTC(2026, 10, 3, 12);

  it("shows the time within a day and the date after", () => {
    expect(usageResetLabel(now + 2 * 3_600_000, now)).toMatch(/^Resets \d{1,2}:\d{2}/u);
    expect(usageResetLabel(now + 4 * 86_400_000, now)).toMatch(/^Resets .*7/u);
    expect(usageResetLabel(null, now)).toBeNull();
  });
});

describe("usagePlanLabel", () => {
  it("capitalizes the plan and hides unknown plans", () => {
    expect(usagePlanLabel("pro")).toBe("Pro");
    expect(usagePlanLabel("unknown")).toBeNull();
    expect(usagePlanLabel(null)).toBeNull();
  });
});
