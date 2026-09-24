import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AutomationModelUsageRecord,
  listUnbilledAutomationModelUsage,
  markAutomationModelUsageBilled,
  markAutomationModelUsageBillingAttempted,
  recordAutomationModelUsage,
  setAutomationModelUsageCost,
} from "../db/automation-model-usage.js";
import type { trackAutomationInferenceUsage } from "../billing/autumn.js";
import type { getAIGatewayModelPricing } from "./model-pricing.js";
import {
  recordBrokeredModelUsage,
  settleUnbilledAutomationModelUsage,
} from "./model-usage-billing.js";

const usage = {
  cacheWriteTokens: 0,
  cachedInputTokens: 0,
  inputTokens: 1_000,
  outputTokens: 100,
};

function dependencies() {
  return {
    getPricing: vi.fn<typeof getAIGatewayModelPricing>()
      .mockResolvedValue({ input: "0.000002", output: "0.00001" }),
    list: vi.fn<typeof listUnbilledAutomationModelUsage>(),
    markAttempted: vi.fn<typeof markAutomationModelUsageBillingAttempted>()
      .mockResolvedValue(undefined),
    markBilled: vi.fn<typeof markAutomationModelUsageBilled>()
      .mockResolvedValue(undefined),
    now: () => Date.parse("2026-09-24T12:00:00.000Z"),
    record: vi.fn<typeof recordAutomationModelUsage>(async (input) => ({
      ...input,
      id: "usage-1",
    })),
    setCost: vi.fn<typeof setAutomationModelUsageCost>().mockResolvedValue(undefined),
    track: vi.fn<typeof trackAutomationInferenceUsage>().mockResolvedValue(undefined),
  };
}

function usageRecord(id: string, costMicros: number): AutomationModelUsageRecord {
  return {
    ...usage,
    costMicros,
    id,
    inferenceSource: "responder",
    model: "gpt-5.4",
    organizationId: "organization-1",
    provider: "openai",
    runId: "run-1",
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

  it("reports Responder-funded usage in dollars keyed by the usage row", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    const deps = dependencies();

    await recordBrokeredModelUsage({ ...request, inferenceSource: "responder" }, deps);

    expect(deps.getPricing).toHaveBeenCalledWith("openai/gpt-5.4");
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({
      costMicros: 3_000,
      settled: false,
    }));
    expect(deps.track).toHaveBeenCalledWith({
      costMicros: 3_000,
      model: "gpt-5.4",
      organizationId: "organization-1",
      runId: "run-1",
      usageId: "usage-1",
    });
    expect(deps.markBilled).toHaveBeenCalledWith("usage-1");
  });

  it("records organization-funded usage without billing it", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    const deps = dependencies();

    await recordBrokeredModelUsage({ ...request, inferenceSource: "byok" }, deps);

    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({
      costMicros: 3_000,
      inferenceSource: "byok",
      settled: true,
    }));
    expect(deps.track).not.toHaveBeenCalled();
  });

  it("keeps usage unbilled when pricing is unavailable", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    const deps = dependencies();
    deps.getPricing.mockRejectedValueOnce(new Error("offline"));
    deps.getPricing.mockResolvedValueOnce(null);

    await expect(recordBrokeredModelUsage(
      { ...request, inferenceSource: "responder" },
      deps,
    )).rejects.toThrow("No AI Gateway pricing");
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({
      costMicros: null,
      settled: false,
    }));
    expect(deps.track).not.toHaveBeenCalled();
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
      failed: 1,
      settled: 1,
    });
    expect(deps.list).toHaveBeenCalledWith({
      createdAfter: new Date("2026-09-23T13:00:00.000Z"),
      createdBefore: new Date("2026-09-24T11:59:00.000Z"),
      limit: 200,
    });
    expect(deps.markBilled).toHaveBeenCalledExactlyOnceWith("usage-2");
    expect(deps.markAttempted).toHaveBeenCalledWith(["usage-1"]);
  });
});
