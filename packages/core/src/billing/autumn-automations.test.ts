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
  checkUsageAllowance,
  checkWorkAllowance,
  creditMachineHours,
  creditUsageCharge,
  organizationUsesMachineHours,
  summarizeAutomationBillingCustomer,
  trackAutomationInferenceUsage,
  trackMachineHours,
} = await import("./autumn.js");

function customer(
  subscriptions: Array<Record<string, unknown>>,
  balances: Record<string, unknown> = {},
): Customer {
  return { balances, id: "organization-1", subscriptions } as unknown as Customer;
}

function balance(overrides: Record<string, unknown> = {}) {
  return {
    granted: 2,
    nextResetAt: 11,
    overageAllowed: false,
    remaining: 2,
    unlimited: false,
    usage: 0,
    ...overrides,
  };
}

const freePlan = [{ planId: "responder_plan_free", status: "active" }];

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

    await expect(checkUsageAllowance("organization-1")).resolves.toEqual({
      allowed: true,
      nextResetAt: 5,
    });
    expect(client.billing.attach).toHaveBeenCalledWith({
      customerId: "organization-1",
      planId: "responder_plan_free",
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

    await expect(checkUsageAllowance("organization-1")).resolves.toEqual({
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

    await expect(checkUsageAllowance("organization-1")).resolves.toEqual({
      allowed: true,
      nextResetAt: 4,
    });
  });

  it("blocks Responder-funded inference once the balance is used up", async () => {
    client.check.mockResolvedValue({
      allowed: false,
      balance: { nextResetAt: 9, remaining: 0 },
    });

    await expect(checkUsageAllowance("organization-1")).resolves.toEqual({
      allowed: false,
      nextResetAt: 9,
    });
    expect(client.billing.attach).not.toHaveBeenCalled();
  });

  it("allows inference without metering when billing is disabled", async () => {
    vi.stubEnv("BILLING_ENABLED", "false");

    await expect(checkUsageAllowance("organization-1")).resolves.toEqual({
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

  it("starts a run on its own key while machine hours last", async () => {
    client.customers.getOrCreate.mockResolvedValue(customer(freePlan, {
      responder_automation_inference: balance({ granted: 5, remaining: 0, usage: 5 }),
      responder_machine_hours: balance({ remaining: 1 }),
    }));

    await expect(checkWorkAllowance("organization-1", { responderModels: false }))
      .resolves.toEqual({
        allowed: true,
        exhausted: null,
        machinesUseCredit: false,
        nextResetAt: null,
      });
  });

  it("stops Responder-funded work once the usage credit is used up", async () => {
    client.customers.getOrCreate.mockResolvedValue(customer(freePlan, {
      responder_automation_inference: balance({ granted: 5, nextResetAt: null, remaining: 0 }),
      responder_machine_hours: balance(),
    }));

    await expect(checkWorkAllowance("organization-1", { responderModels: true }))
      .resolves.toEqual({
        allowed: false,
        exhausted: "usage_credit",
        machinesUseCredit: false,
        nextResetAt: null,
      });
  });

  it("stops work at the machine hours cap unless the plan bills extra hours", async () => {
    const exhausted = balance({ remaining: 0, usage: 2 });
    client.customers.getOrCreate.mockResolvedValueOnce(customer(freePlan, {
      responder_automation_inference: balance({ granted: 5, remaining: 5 }),
      responder_machine_hours: exhausted,
    }));

    await expect(checkWorkAllowance("organization-1", { responderModels: false }))
      .resolves.toMatchObject({ allowed: false, exhausted: "machine_hours", nextResetAt: 11 });

    client.customers.getOrCreate.mockResolvedValueOnce(customer(
      [{ planId: "responder_plan_pro", status: "active" }],
      {
        responder_automation_inference: balance({ granted: 100, remaining: 0, overageAllowed: true }),
        responder_machine_hours: { ...exhausted, overageAllowed: true },
      },
    ));

    await expect(checkWorkAllowance("organization-1", { responderModels: false }))
      .resolves.toMatchObject({ allowed: true, exhausted: null });
  });

  it("looks up and caches whether a plan meters machine hours", async () => {
    client.customers.getOrCreate.mockResolvedValue(customer(freePlan, {
      responder_machine_hours: balance(),
    }));

    await expect(organizationUsesMachineHours("organization-hours")).resolves.toBe(true);
    await expect(organizationUsesMachineHours("organization-hours")).resolves.toBe(true);
    expect(client.customers.getOrCreate).toHaveBeenCalledOnce();

    client.customers.getOrCreate.mockResolvedValue(customer([
      { planId: "responder_automations_100", status: "active" },
    ]));
    await expect(organizationUsesMachineHours("organization-legacy")).resolves.toBe(false);
  });

  it("tracks machine hours with an idempotency key", async () => {
    await trackMachineHours({
      hours: 0.25,
      idempotencyKey: "sandbox-hours:usage-1",
      organizationId: "organization-1",
      properties: { kind: "sandbox" },
    });

    expect(client.track).toHaveBeenCalledWith(
      {
        customerId: "organization-1",
        featureId: "responder_machine_hours",
        properties: { kind: "sandbox" },
        value: 0.25,
      },
      {
        headers: { "Idempotency-Key": "sandbox-hours:usage-1" },
        timeoutMs: 30_000,
      },
    );
  });

  it("credits a charge and machine hours back as negative usage", async () => {
    await creditUsageCharge({
      chargeMicros: 12_345,
      idempotencyKey: "automation-usage-credit:usage-1",
      organizationId: "organization-1",
      properties: { model: "gpt-5.4", runId: "run-1" },
    });
    await creditMachineHours({
      hours: 0.25,
      idempotencyKey: "sandbox-usage-credit:usage-2",
      organizationId: "organization-1",
      properties: { kind: "sandbox" },
    });

    expect(client.track).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: "responder_automation_inference",
        value: -0.012345,
      }),
      expect.objectContaining({
        headers: { "Idempotency-Key": "automation-usage-credit:usage-1" },
      }),
    );
    expect(client.track).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: "responder_machine_hours", value: -0.25 }),
      expect.objectContaining({
        headers: { "Idempotency-Key": "sandbox-usage-credit:usage-2" },
      }),
    );
  });

  it("summarizes a plan with machine hours", () => {
    expect(summarizeAutomationBillingCustomer(customer(
      [{ canceledAt: null, planId: "responder_plan_pro", status: "active" }],
      {
        responder_automation_inference: balance({
          granted: 100,
          overageAllowed: true,
          remaining: 40,
          usage: 60,
        }),
        responder_machine_hours: balance({ granted: 50, remaining: 45, usage: 5 }),
      },
    ))).toMatchObject({
      allowance: 100,
      creditOverageAllowed: true,
      machineHours: { granted: 50, overageAllowed: false, remaining: 45, usage: 5 },
      paid: true,
      planId: "responder_plan_pro",
      planName: "Pro",
      remaining: 40,
      usage: 60,
    });
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
      machineHours: null,
      nextResetAt: 7,
      paid: true,
      planId: "responder_automations_200",
      planName: "$200 / month",
      remaining: 0,
      scheduledPlanId: "responder_automations_100",
      scheduledPlanName: "$100 / month",
      usage: 201,
    });
  });
});
