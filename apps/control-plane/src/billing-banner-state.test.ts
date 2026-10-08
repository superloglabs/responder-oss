import { describe, expect, it } from "vitest";
import { billingBanner, type BillingBannerSummary } from "./billing-banner-state";

function usageSummary(
  automations: Partial<NonNullable<BillingBannerSummary["automations"]>> = {},
): BillingBannerSummary {
  return {
    automations: {
      configured: true,
      creditOverageAllowed: false,
      machineHours: { overageAllowed: false, remaining: 2 },
      remaining: 5,
      ...automations,
    },
    configured: true,
    enabled: true,
    payAsYouGo: false,
    remaining: 0,
    usageBased: true,
  };
}

describe("billingBanner", () => {
  it("shows nothing while balances remain", () => {
    expect(billingBanner(usageSummary())).toBeNull();
  });

  it("shows a banner when a balance without overage is used up", () => {
    expect(billingBanner(usageSummary({ remaining: 0 }))).toBe("usage");
    expect(billingBanner(usageSummary({
      machineHours: { overageAllowed: false, remaining: 0 },
    }))).toBe("machine_hours");
  });

  it("shows nothing while a paid plan bills usage past its allowance", () => {
    expect(billingBanner(usageSummary({
      creditOverageAllowed: true,
      machineHours: { overageAllowed: true, remaining: 0 },
      remaining: 0,
    }))).toBeNull();
  });

  it("checks each balance on its own", () => {
    expect(billingBanner(usageSummary({
      creditOverageAllowed: true,
      machineHours: { overageAllowed: false, remaining: 0 },
      remaining: 0,
    }))).toBe("machine_hours");
    expect(billingBanner(usageSummary({
      machineHours: { overageAllowed: true, remaining: 0 },
      remaining: 0,
    }))).toBe("usage");
  });

  it("shows nothing for unlimited balances", () => {
    expect(billingBanner(usageSummary({
      creditUnlimited: true,
      machineHours: { overageAllowed: false, remaining: 0, unlimited: true },
      remaining: 0,
    }))).toBeNull();
  });

  it("keeps the investigation credit banner for other workspaces", () => {
    expect(billingBanner({ ...usageSummary(), usageBased: false })).toBe("investigations");
    expect(billingBanner({ ...usageSummary(), payAsYouGo: true, usageBased: false })).toBeNull();
  });
});
