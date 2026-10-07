import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationModelUsageRecord } from "../db/automation-model-usage.js";
import {
  completeResponderInference,
  recordBrokeredModelUsage,
} from "./model-usage-billing.js";

// An edition that charges a fifth more than provider cost.
vi.mock("../billing/usage-pricing.js", () => ({
  inferenceChargeMicros: (costMicros: number) => costMicros * 1.2,
  sandboxChargeMicros: () => 0,
}));

const usage = {
  cacheWriteTokens: 0,
  cachedInputTokens: 0,
  inputTokens: 1_000,
  outputTokens: 100,
};

function dependencies() {
  return {
    complete: vi.fn(async (id: string, _usage: unknown, costMicros: number | null) => ({
      ...usage,
      costMicros,
      id,
      inferenceSource: "responder",
      model: "gpt-5.4",
      organizationId: "organization-1",
      provider: "openai",
      runId: "run-1",
      waived: false,
    }) as AutomationModelUsageRecord),
    getPricing: vi.fn().mockResolvedValue({ input: "0.000002", output: "0.00001" }),
    markBilled: vi.fn().mockResolvedValue(undefined),
    markWaivedSettled: vi.fn().mockResolvedValue(undefined),
    record: vi.fn(async (input: Omit<AutomationModelUsageRecord, "id" | "waived">) => ({
      ...input,
      id: "usage-1",
      waived: false,
    })),
    setCost: vi.fn().mockResolvedValue(undefined),
    track: vi.fn().mockResolvedValue(undefined),
  };
}

describe("inference charge", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("stores and bills Responder-funded usage at the charged amount", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    const deps = dependencies();

    await completeResponderInference({
      model: "gpt-5.4",
      provider: "openai",
      reservationId: "reservation-1",
      usage,
    }, deps);

    expect(deps.complete).toHaveBeenCalledWith("reservation-1", usage, 3_600);
    expect(deps.track).toHaveBeenCalledWith(expect.objectContaining({ costMicros: 3_600 }));
  });

  it("stores organization-funded usage at provider cost", async () => {
    const deps = dependencies();

    await recordBrokeredModelUsage({
      inferenceSource: "byok",
      model: "gpt-5.4",
      organizationId: "organization-1",
      provider: "openai",
      runId: "run-1",
      usage,
    }, deps);

    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({ costMicros: 3_000 }));
    expect(deps.track).not.toHaveBeenCalled();
  });
});
