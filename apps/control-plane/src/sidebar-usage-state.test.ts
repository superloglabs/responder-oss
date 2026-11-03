import { describe, expect, it } from "vitest";
import { sidebarUsage, type SidebarUsageSummary } from "./sidebar-usage-state";

function paidSummary(
  automations: Partial<NonNullable<SidebarUsageSummary["automations"]>> = {},
): SidebarUsageSummary {
  return {
    automations: {
      allowance: 100,
      configured: true,
      creditUnlimited: false,
      machineHours: { granted: 50, remaining: 40, unlimited: false, usage: 10 },
      paid: true,
      planName: "Pro",
      usage: 25,
      ...automations,
    },
    enabled: true,
  };
}

describe("sidebarUsage", () => {
  it("shows the credit and machine hours of a paid plan", () => {
    expect(sidebarUsage(paidSummary())).toEqual({
      meters: [
        { kind: "credit", percent: 25, total: 100, used: 25 },
        { kind: "machine_hours", percent: 20, total: 50, used: 10 },
      ],
      planName: "Pro",
    });
  });

  it("shows nothing on the free plan or without billing", () => {
    expect(sidebarUsage(paidSummary({ paid: false }))).toBeNull();
    expect(sidebarUsage(paidSummary({ configured: false }))).toBeNull();
    expect(sidebarUsage({ ...paidSummary(), enabled: false })).toBeNull();
    expect(sidebarUsage({ ...paidSummary(), automations: null })).toBeNull();
  });

  it("caps the bar when usage passes the allowance", () => {
    const usage = sidebarUsage(paidSummary({ machineHours: null, usage: 130 }));
    expect(usage?.meters).toEqual([{ kind: "credit", percent: 100, total: 100, used: 130 }]);
  });

  it("leaves out unlimited balances", () => {
    expect(sidebarUsage(paidSummary({ creditUnlimited: true }))?.meters.map((m) => m.kind))
      .toEqual(["machine_hours"]);
    expect(sidebarUsage(paidSummary({
      creditUnlimited: true,
      machineHours: { granted: 0, remaining: 0, unlimited: true, usage: 3 },
    }))).toBeNull();
  });
});
