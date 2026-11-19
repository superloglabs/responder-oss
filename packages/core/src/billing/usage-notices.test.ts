import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationBillingSummary } from "./autumn.js";
import { sendUsageNotices, usageLimitReached } from "./usage-notices.js";

function summary(overrides: Partial<AutomationBillingSummary> = {}): AutomationBillingSummary {
  return {
    allowance: 5,
    cancelsAtPeriodEnd: false,
    configured: true,
    creditOverageAllowed: false,
    creditUnlimited: false,
    enabled: true,
    includesTeammates: false,
    machineHours: {
      granted: 2,
      nextResetAt: 1_800_000_100,
      overageAllowed: false,
      remaining: 1,
      unlimited: false,
      usage: 1,
    },
    nextResetAt: null,
    paid: false,
    periodStart: null,
    planId: "responder_plan_free",
    planName: "Free",
    planPrice: 0,
    plans: [],
    remaining: 3,
    runBilling: null,
    scheduledPlanId: null,
    scheduledPlanName: null,
    usage: 2,
    ...overrides,
  };
}

describe("usageLimitReached", () => {
  it("reports nothing while balances remain", () => {
    expect(usageLimitReached(summary())).toBeNull();
  });

  it("reports a used-up credit or machine hours with that balance's reset", () => {
    expect(usageLimitReached(summary({ remaining: 0.004 }))).toEqual({
      balance: "usage_credit",
      modelRunsOnly: true,
      nextResetAt: null,
    });
    expect(usageLimitReached(summary({
      machineHours: { ...summary().machineHours!, remaining: 0.01 },
    }))).toEqual({ balance: "machine_hours", modelRunsOnly: false, nextResetAt: 1_800_000_100 });
  });

  it("ignores usage past a balance the plan bills for", () => {
    expect(usageLimitReached(summary({
      creditOverageAllowed: true,
      machineHours: { ...summary().machineHours!, overageAllowed: true, remaining: 0 },
      remaining: 0,
    }))).toBeNull();
  });

  it("reports a used-up balance without overage when the other balance has it", () => {
    expect(usageLimitReached(summary({
      creditOverageAllowed: true,
      machineHours: { ...summary().machineHours!, remaining: 0 },
      remaining: 0,
    }))).toEqual({ balance: "machine_hours", modelRunsOnly: false, nextResetAt: 1_800_000_100 });
    expect(usageLimitReached(summary({
      machineHours: { ...summary().machineHours!, overageAllowed: true, remaining: 0 },
      remaining: 0,
    }))).toEqual({ balance: "usage_credit", modelRunsOnly: true, nextResetAt: null });
  });

  it("reports machine hours when both balances are used up", () => {
    expect(usageLimitReached(summary({
      machineHours: { ...summary().machineHours!, remaining: 0 },
      remaining: 0,
    }))).toEqual({ balance: "machine_hours", modelRunsOnly: false, nextResetAt: 1_800_000_100 });
  });

  it("ignores unlimited balances", () => {
    expect(usageLimitReached(summary({
      creditUnlimited: true,
      machineHours: { ...summary().machineHours!, remaining: 0, unlimited: true },
      remaining: 0,
    }))).toBeNull();
  });

  it("ignores a workspace without configured billing", () => {
    expect(usageLimitReached(summary({ configured: false, remaining: 0 }))).toBeNull();
  });
});

describe("sendUsageNotices", () => {
  beforeEach(() => vi.stubEnv("BILLING_ENABLED", "true"));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("notifies organizations that ran out and keeps going after a failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const since = new Date("2026-10-08T12:00:00Z");
    const listOrganizations = vi.fn().mockResolvedValue(["org-ok", "org-down", "org-out"]);
    const getSummary = vi.fn(async (organizationId: string) => {
      if (organizationId === "org-down") throw new Error("Autumn unavailable");
      return summary(organizationId === "org-out" ? { remaining: 0 } : {});
    });
    const notify = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendUsageNotices(since, [], { getSummary, listOrganizations, notify, usesUsageBilling: vi.fn().mockResolvedValue(true) }),
    ).resolves.toEqual({ checked: 3, failedOrganizationIds: ["org-down"], notified: 1 });

    expect(listOrganizations).toHaveBeenCalledWith(since);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("org-out", null, {
      refreshSlackChannels: undefined,
      usage: { balance: "usage_credit", investigations: true, modelRunsOnly: true },
      usageBased: true,
    });
  });

  it("checks organizations whose last check failed without new usage", async () => {
    const listOrganizations = vi.fn().mockResolvedValue(["org-out"]);
    const checked: string[] = [];
    const getSummary = vi.fn(async (organizationId: string) => {
      checked.push(organizationId);
      return summary({ remaining: 0 });
    });
    const notify = vi.fn().mockResolvedValue(undefined);

    await sendUsageNotices(new Date(), ["org-retry", "org-out"], {
      getSummary,
      listOrganizations,
      notify,
      usesUsageBilling: vi.fn().mockResolvedValue(false),
    });

    expect(checked).toEqual(["org-out", "org-retry"]);
    expect(notify).toHaveBeenCalledWith("org-retry", null, {
      refreshSlackChannels: undefined,
      usage: { balance: "usage_credit", investigations: false, modelRunsOnly: true },
      usageBased: true,
    });
  });

  it("warns about a first failure and logs an error when the retry fails too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dependencies = {
      getSummary: vi.fn().mockRejectedValue(new Error("Autumn could not be reached")),
      listOrganizations: vi.fn().mockResolvedValue(["org-new"]),
      notify: vi.fn(),
      usesUsageBilling: vi.fn(),
    };

    await expect(sendUsageNotices(new Date(), ["org-retry"], dependencies)).resolves.toEqual({
      checked: 2,
      failedOrganizationIds: ["org-new", "org-retry"],
      notified: 0,
    });

    const logged = (spy: typeof warn) =>
      spy.mock.calls.map(([line]) => JSON.parse(String(line)).organizationId);
    expect(logged(warn)).toEqual(["org-new"]);
    expect(logged(error)).toEqual(["org-retry"]);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      error: "Autumn could not be reached",
      event: "usage_notice_failed",
    });
  });

  it("does nothing when billing is disabled", async () => {
    vi.stubEnv("BILLING_ENABLED", "false");
    const listOrganizations = vi.fn();

    await sendUsageNotices(new Date(), [], {
      getSummary: vi.fn(),
      listOrganizations,
      notify: vi.fn(),
      usesUsageBilling: vi.fn(),
    });

    expect(listOrganizations).not.toHaveBeenCalled();
  });
});
