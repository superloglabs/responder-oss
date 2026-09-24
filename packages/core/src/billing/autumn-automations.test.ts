import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Customer } from "autumn-js";

const client = vi.hoisted(() => ({
  billing: { attach: vi.fn(), update: vi.fn() },
  check: vi.fn(),
  customers: { getOrCreate: vi.fn() },
  track: vi.fn(),
}));

vi.mock("autumn-js", () => ({
  Autumn: vi.fn(function Autumn() {
    return client;
  }),
}));

const {
  checkAutomationInferenceAllowance,
  summarizeAutomationBillingCustomer,
  trackAutomationInferenceUsage,
} = await import("./autumn.js");

function customer(subscriptions: Array<Record<string, unknown>>): Customer {
  return { balances: {}, id: "organization-1", subscriptions } as unknown as Customer;
}

describe("automation billing", () => {
  beforeEach(() => {
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("AUTUMN_SECRET_KEY", "autumn-secret");
  });

  afterEach(() => {
    // The Autumn client is cached across tests, so reset its mocks' queued
    // results as well as their calls.
    for (const mock of [
      client.billing.attach,
      client.billing.update,
      client.check,
      client.customers.getOrCreate,
      client.track,
    ]) {
      mock.mockReset();
    }
    vi.unstubAllEnvs();
  });

  it("attaches the free automation plan before the first allowance check", async () => {
    client.check
      .mockResolvedValueOnce({ allowed: false, balance: null })
      .mockResolvedValueOnce({ allowed: true, balance: { nextResetAt: 5 } });
    client.customers.getOrCreate
      .mockResolvedValueOnce(customer([{ planId: "responder_free", status: "active" }]))
      .mockResolvedValueOnce(customer([
        { planId: "responder_free", status: "active" },
        { planId: "responder_automations_free", status: "active" },
      ]));

    await expect(checkAutomationInferenceAllowance("organization-1")).resolves.toEqual({
      allowed: true,
      nextResetAt: 5,
    });
    expect(client.billing.attach).toHaveBeenCalledWith({
      customerId: "organization-1",
      planId: "responder_automations_free",
      redirectMode: "never",
    });
    expect(client.check).toHaveBeenCalledWith({
      customerId: "organization-1",
      featureId: "responder_automation_inference",
      requiredBalance: 0.01,
    });
  });

  it("creates the customer when an organization has never been billed", async () => {
    client.check
      .mockRejectedValueOnce(Object.assign(new Error("Customer not found"), { statusCode: 404 }))
      .mockResolvedValueOnce({ allowed: true, balance: { nextResetAt: 3 } });
    client.customers.getOrCreate
      .mockResolvedValueOnce(customer([{ planId: "responder_free", status: "active" }]))
      .mockResolvedValueOnce(customer([{ planId: "responder_automations_free", status: "active" }]));

    await expect(checkAutomationInferenceAllowance("organization-1")).resolves.toEqual({
      allowed: true,
      nextResetAt: 3,
    });
    expect(client.billing.attach).toHaveBeenCalledOnce();
  });

  it("accepts a free plan attached by a concurrent first run", async () => {
    client.check
      .mockResolvedValueOnce({ allowed: false, balance: null })
      .mockResolvedValueOnce({ allowed: true, balance: { nextResetAt: 4 } });
    client.customers.getOrCreate
      .mockResolvedValueOnce(customer([{ planId: "responder_free", status: "active" }]))
      .mockResolvedValueOnce(customer([{ planId: "responder_automations_free", status: "active" }]));
    client.billing.attach.mockRejectedValueOnce(new Error("Plan already attached"));

    await expect(checkAutomationInferenceAllowance("organization-1")).resolves.toEqual({
      allowed: true,
      nextResetAt: 4,
    });
  });

  it("blocks Responder-funded inference once the balance is used up", async () => {
    client.check.mockResolvedValue({
      allowed: false,
      balance: { nextResetAt: 9, remaining: 0 },
    });

    await expect(checkAutomationInferenceAllowance("organization-1")).resolves.toEqual({
      allowed: false,
      nextResetAt: 9,
    });
    expect(client.billing.attach).not.toHaveBeenCalled();
  });

  it("allows inference without metering when billing is disabled", async () => {
    vi.stubEnv("BILLING_ENABLED", "false");

    await expect(checkAutomationInferenceAllowance("organization-1")).resolves.toEqual({
      allowed: true,
      nextResetAt: null,
    });
    await trackAutomationInferenceUsage({
      costMicros: 1,
      model: "gpt-5.4",
      organizationId: "organization-1",
      runId: "run-1",
      usageId: "usage-1",
    });
    expect(client.check).not.toHaveBeenCalled();
    expect(client.track).not.toHaveBeenCalled();
  });

  it("tracks dollars with an idempotency key and accepts duplicates", async () => {
    client.track.mockRejectedValueOnce(Object.assign(new Error("duplicate"), {
      statusCode: 409,
    }));

    await trackAutomationInferenceUsage({
      costMicros: 12_345,
      model: "gpt-5.4",
      organizationId: "organization-1",
      runId: "run-1",
      usageId: "usage-1",
    });

    expect(client.track).toHaveBeenCalledWith(
      {
        customerId: "organization-1",
        featureId: "responder_automation_inference",
        properties: { model: "gpt-5.4", runId: "run-1" },
        value: 0.012345,
      },
      {
        headers: { "Idempotency-Key": "automation-usage:usage-1" },
        timeoutMs: 30_000,
      },
    );
    client.track.mockRejectedValueOnce(Object.assign(new Error("down"), {
      statusCode: 503,
    }));
    await expect(trackAutomationInferenceUsage({
      costMicros: 1,
      model: "gpt-5.4",
      organizationId: "organization-1",
      runId: "run-1",
      usageId: "usage-2",
    })).rejects.toThrow("down");
  });

  it("summarizes the active and scheduled automation plans", () => {
    expect(summarizeAutomationBillingCustomer({
      balances: {
        responder_automation_inference: {
          granted: 200,
          nextResetAt: 7,
          remaining: -1,
          usage: 201,
        },
      },
      subscriptions: [
        { planId: "responder_pay_as_you_go", status: "active" },
        { canceledAt: null, planId: "responder_automations_200", status: "active" },
        { planId: "responder_automations_100", status: "scheduled" },
      ],
    } as unknown as Customer)).toMatchObject({
      allowance: 200,
      cancelsAtPeriodEnd: false,
      nextResetAt: 7,
      planId: "responder_automations_200",
      remaining: 0,
      scheduledPlanId: "responder_automations_100",
      usage: 201,
    });
  });
});
