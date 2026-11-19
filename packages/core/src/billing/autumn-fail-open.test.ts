import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Uses the real Autumn SDK, so these tests follow its fail-open behavior
// when Autumn cannot be reached.
const runBillingAccounts = vi.hoisted(() => ({ getRunBillingAccount: vi.fn() }));
vi.mock("../db/run-billing-accounts.js", () => runBillingAccounts);

const {
  checkWorkAllowance,
  consumeInvestigation,
  getAutomationBillingSummary,
  reserveInvestigation,
} = await import("./autumn.js");

describe("Autumn outage", () => {
  beforeEach(() => {
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("AUTUMN_SECRET_KEY", "am_sk_test_outage");
    runBillingAccounts.getRunBillingAccount.mockResolvedValue(null);
    // The SDK logs the network failure and its fail-open response.
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function unreachable() {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
  }

  it("lets investigations and runs continue", async () => {
    unreachable();

    await expect(consumeInvestigation("organization-1", "investigation-1")).resolves.toEqual({
      allowed: true,
      configured: true,
      nextResetAt: null,
    });
    await expect(reserveInvestigation("organization-1", "investigation-1")).resolves.toEqual({
      allowed: true,
      configured: true,
      nextResetAt: null,
      reservationId: null,
    });
    await expect(checkWorkAllowance("organization-1", { responderModels: true })).resolves.toEqual({
      allowed: true,
      exhausted: null,
      machinesUseCredit: false,
      nextResetAt: null,
    });
  });

  it("summarizes billing without limits, or throws when asked not to fail open", async () => {
    unreachable();

    await expect(getAutomationBillingSummary("organization-1")).resolves.toMatchObject({
      configured: true,
      includesTeammates: true,
      machineHours: null,
    });
    await expect(
      getAutomationBillingSummary("organization-1", undefined, { failOpen: false }),
    ).rejects.toThrow("Autumn could not be reached");
  });

  it("still rejects a malformed customer from Autumn", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "organization-1" })));

    await expect(consumeInvestigation("organization-1", "investigation-1")).rejects.toThrow(
      "Response validation failed",
    );
  });
});
