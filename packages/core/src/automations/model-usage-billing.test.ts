import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AutomationModelUsageRecord,
  completeResponderModelUsage,
  listUnbilledAutomationModelUsage,
  markAutomationModelUsageBilled,
  markAutomationModelUsageBillingAttempted,
  purgeAbandonedResponderModelUsage,
  recordAutomationModelUsage,
  reserveResponderModelUsage,
  setAutomationModelUsageCost,
} from "../db/automation-model-usage.js";
import type {
  checkAutomationInferenceAllowance,
  trackAutomationInferenceUsage,
} from "../billing/autumn.js";
import type { getAIGatewayModelPricing } from "./model-pricing.js";
import {
  completeResponderInference,
  recordBrokeredModelUsage,
  reserveResponderInference,
  settleUnbilledAutomationModelUsage,
} from "./model-usage-billing.js";

const usage = {
  cacheWriteTokens: 0,
  cachedInputTokens: 0,
  inputTokens: 1_000,
  outputTokens: 100,
};

function usageRecord(
  id: string,
  costMicros: number | null,
  inferenceSource: AutomationModelUsageRecord["inferenceSource"] = "responder",
): AutomationModelUsageRecord {
  return {
    ...usage,
    costMicros,
    id,
    inferenceSource,
    model: "gpt-5.4",
    organizationId: "organization-1",
    provider: "openai",
    runId: "run-1",
  };
}

function dependencies() {
  return {
    complete: vi.fn<typeof completeResponderModelUsage>(
      async (id, _usage, costMicros) => usageRecord(id, costMicros),
    ),
    getPricing: vi.fn<typeof getAIGatewayModelPricing>()
      .mockResolvedValue({ input: "0.000002", output: "0.00001" }),
    list: vi.fn<typeof listUnbilledAutomationModelUsage>(),
    markAttempted: vi.fn<typeof markAutomationModelUsageBillingAttempted>()
      .mockResolvedValue(undefined),
    markBilled: vi.fn<typeof markAutomationModelUsageBilled>()
      .mockResolvedValue(undefined),
    now: () => Date.parse("2026-09-24T12:00:00.000Z"),
    purgeAbandoned: vi.fn<typeof purgeAbandonedResponderModelUsage>()
      .mockResolvedValue(0),
    record: vi.fn<typeof recordAutomationModelUsage>(async (input) => ({
      ...input,
      id: "usage-1",
    })),
    setCost: vi.fn<typeof setAutomationModelUsageCost>().mockResolvedValue(undefined),
    track: vi.fn<typeof trackAutomationInferenceUsage>().mockResolvedValue(undefined),
  };
}

const request = {
  model: "gpt-5.4",
  organizationId: "organization-1",
  provider: "openai" as const,
  runId: "run-1",
  usage,
};

describe("automation model usage billing", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reserves against the allowance in dollars and refuses what it cannot cover", async () => {
    const checkAllowance = vi.fn<typeof checkAutomationInferenceAllowance>()
      .mockResolvedValueOnce({ allowed: true, nextResetAt: null })
      .mockResolvedValueOnce({ allowed: false, nextResetAt: null });
    const reserve = vi.fn<typeof reserveResponderModelUsage>(
      async (_input, isAllowed) => (await isAllowed(2_500_000)) ? "reservation-1" : null,
    );
    const input = { ...request, estimateMicros: 500_000 };

    await expect(reserveResponderInference(input, { checkAllowance, reserve }))
      .resolves.toBe("reservation-1");
    await expect(reserveResponderInference(input, { checkAllowance, reserve }))
      .resolves.toBeNull();
    expect(checkAllowance).toHaveBeenCalledWith("organization-1", 2.5);
  });

  it("replaces a reservation with the actual cost and reports it once", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    const deps = dependencies();

    await completeResponderInference({
      model: "gpt-5.4",
      provider: "openai",
      reservationId: "reservation-1",
      usage,
    }, deps);

    expect(deps.getPricing).toHaveBeenCalledWith("openai/gpt-5.4");
    expect(deps.complete).toHaveBeenCalledWith("reservation-1", usage, 3_000);
    expect(deps.track).toHaveBeenCalledWith({
      costMicros: 3_000,
      model: "gpt-5.4",
      organizationId: "organization-1",
      runId: "run-1",
      usageId: "reservation-1",
    });
    expect(deps.markBilled).toHaveBeenCalledWith("reservation-1");
  });

  it("retries recording actual usage through a short database outage", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    const deps = { ...dependencies(), retryDelaysMs: [0, 0] };
    deps.complete.mockRejectedValueOnce(new Error("connection reset"));

    await completeResponderInference({
      model: "gpt-5.4",
      provider: "openai",
      reservationId: "reservation-1",
      usage,
    }, deps);

    expect(deps.complete).toHaveBeenCalledTimes(2);
    expect(deps.markBilled).toHaveBeenCalledWith("reservation-1");
  });

  it("closes a completed reservation without reporting when billing is disabled", async () => {
    vi.stubEnv("BILLING_ENABLED", "false");
    const deps = dependencies();

    await completeResponderInference({
      model: "gpt-5.4",
      provider: "openai",
      reservationId: "reservation-1",
      usage,
    }, deps);

    expect(deps.track).not.toHaveBeenCalled();
    expect(deps.markBilled).toHaveBeenCalledWith("reservation-1");
  });

  it("records organization-funded usage without billing it", async () => {
    const deps = dependencies();

    await recordBrokeredModelUsage({ ...request, inferenceSource: "byok" }, deps);

    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({
      costMicros: 3_000,
      inferenceSource: "byok",
      settled: true,
    }));
    expect(deps.track).not.toHaveBeenCalled();
  });

  it("keeps unpriced organization-funded usage open for a later price", async () => {
    const deps = dependencies();
    deps.getPricing.mockRejectedValueOnce(new Error("offline"));

    await recordBrokeredModelUsage({ ...request, inferenceSource: "byos" }, deps);

    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({
      costMicros: null,
      settled: false,
    }));
  });

  it("prices unpriced rows and bills only Responder-funded rows", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    const deps = dependencies();
    deps.list.mockResolvedValue([
      usageRecord("usage-1", null),
      usageRecord("usage-2", null, "byok"),
    ]);

    await expect(settleUnbilledAutomationModelUsage(deps)).resolves.toEqual({
      abandoned: 0,
      failed: 0,
      settled: 2,
    });
    expect(deps.setCost).toHaveBeenCalledWith("usage-1", 3_000);
    expect(deps.setCost).toHaveBeenCalledWith("usage-2", 3_000);
    expect(deps.track).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      costMicros: 3_000,
      usageId: "usage-1",
    }));
    expect(deps.markBilled).toHaveBeenCalledWith("usage-1");
    expect(deps.markBilled).toHaveBeenCalledWith("usage-2");
  });

  it("retries unbilled rows only inside the idempotency window", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    const deps = dependencies();
    deps.list.mockResolvedValue([
      usageRecord("usage-1", 10),
      usageRecord("usage-2", 20),
    ]);
    deps.track.mockRejectedValueOnce(new Error("Autumn unavailable"));

    await expect(settleUnbilledAutomationModelUsage(deps)).resolves.toEqual({
      abandoned: 0,
      failed: 1,
      settled: 1,
    });
    expect(deps.purgeAbandoned).toHaveBeenCalledWith(new Date("2026-09-24T12:00:00.000Z"));
    expect(deps.list).toHaveBeenCalledWith({
      createdAfter: new Date("2026-09-23T13:00:00.000Z"),
      createdBefore: new Date("2026-09-24T11:59:00.000Z"),
      limit: 200,
    });
    expect(deps.markBilled).toHaveBeenCalledExactlyOnceWith("usage-2");
    expect(deps.markAttempted).toHaveBeenCalledWith(["usage-1"]);
  });
});
