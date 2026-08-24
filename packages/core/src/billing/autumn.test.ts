import { afterEach, describe, expect, it, vi } from "vitest";
import type { Customer } from "autumn-js";
import {
  consumeInvestigation,
  getBillingSummary,
  summarizeBillingCustomer,
} from "./autumn.js";

describe("Autumn billing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps local development available when Autumn is not configured", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("AUTUMN_SECRET_KEY", "");

    await expect(getBillingSummary("organization-1")).resolves.toEqual({
      configured: false,
      enabled: true,
      included: 50,
      nextResetAt: null,
      overagePrice: 1.5,
      payAsYouGo: false,
      remaining: 50,
      usage: 0,
    });
    await expect(
      consumeInvestigation("organization-1", "investigation-1"),
    ).resolves.toEqual({
      allowed: true,
      configured: false,
      consumed: false,
      nextResetAt: null,
    });
  });

  it("does not silently bypass metering in production", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("AUTUMN_SECRET_KEY", "");
    vi.stubEnv("NODE_ENV", "production");

    await expect(
      consumeInvestigation("organization-1", "investigation-1"),
    ).rejects.toThrow("AUTUMN_SECRET_KEY is required in production");
  });

  it("summarizes pay-as-you-go usage without exposing negative remaining units", () => {
    const customer = {
      balances: {
        responder_investigations: {
          nextResetAt: 1_800_000_000_000,
          remaining: -3,
          usage: 53,
        },
      },
      subscriptions: [
        {
          planId: "responder_pay_as_you_go",
          status: "active",
        },
      ],
    } as unknown as Customer;

    expect(summarizeBillingCustomer(customer)).toEqual({
      configured: true,
      enabled: true,
      included: 50,
      nextResetAt: 1_800_000_000_000,
      overagePrice: 1.5,
      payAsYouGo: true,
      remaining: 0,
      usage: 53,
    });
  });

  it("keeps billing and metering off unless a deployment opts in", async () => {
    vi.stubEnv("BILLING_ENABLED", "false");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTUMN_SECRET_KEY", "");

    await expect(getBillingSummary("organization-1")).resolves.toMatchObject({
      configured: false,
      enabled: false,
    });
    await expect(
      consumeInvestigation("organization-1", "investigation-1"),
    ).resolves.toEqual({
      allowed: true,
      configured: false,
      consumed: false,
      nextResetAt: null,
    });
  });
});
