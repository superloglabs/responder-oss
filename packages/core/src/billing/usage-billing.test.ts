import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { getAIGatewayModelPricing } from "../automations/model-pricing.js";
import type { AgentModelUsageRecord } from "../db/agent-model-usage.js";
import type { SandboxUsageRecord } from "../db/sandbox-usage.js";
import type {
  organizationUsesMachineHours,
  trackMachineHours,
  trackUsageCharge,
} from "./autumn.js";
import {
  finishSandboxUsage,
  recordAgentModelUsage,
  settleAgentModelUsage,
  settleSandboxUsage,
  settleUnbilledUsage,
  usagePeriodStart,
} from "./usage-billing.js";

// An edition that prices sandbox time and adds half to model costs.
vi.mock("./usage-pricing.js", () => ({
  inferenceChargeMicros: (costMicros: number) => costMicros * 1.5,
  sandboxChargeMicros: (
    resources: { cpu: number; diskGiB: number; memoryGiB: number },
    seconds: number,
  ) => seconds * (resources.cpu * 10 + resources.memoryGiB * 2 + resources.diskGiB * 0.01),
}));

function sandboxRow(overrides: Partial<SandboxUsageRecord> = {}): SandboxUsageRecord {
  return {
    billable: true,
    chargeMicros: null,
    cpu: 2,
    diskGiB: 10,
    id: "sandbox-usage-1",
    memoryGiB: 4,
    organizationId: "organization-1",
    startedAt: new Date("2026-09-29T10:00:00.000Z"),
    stoppedAt: new Date("2026-09-29T10:10:00.000Z"),
    workload: "automation",
    workloadId: "run-1",
    ...overrides,
  };
}

function agentRow(overrides: Partial<AgentModelUsageRecord> = {}): AgentModelUsageRecord {
  return {
    billable: true,
    cachedInputTokens: 0,
    chargeMicros: null,
    id: "agent-usage-1",
    inputTokens: 2_000,
    model: "gpt-5.4",
    organizationId: "organization-1",
    outputTokens: 200,
    requestUsage: null,
    requests: 2,
    workload: "investigation",
    workloadId: "investigation-1",
    ...overrides,
  };
}

function dependencies() {
  return {
    getPricing: vi.fn<typeof getAIGatewayModelPricing>()
      .mockResolvedValue({ input: "0.000002", output: "0.00001" }),
    insert: vi.fn(async (input: Omit<AgentModelUsageRecord, "id">) => ({
      ...input,
      id: "agent-usage-1",
    })),
    markBilled: vi.fn().mockResolvedValue(undefined),
    setCharge: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(async () => sandboxRow()),
    track: vi.fn<typeof trackUsageCharge>().mockResolvedValue(undefined),
    trackMachineHours: vi.fn<typeof trackMachineHours>().mockResolvedValue(undefined),
    usesMachineHours: vi.fn<typeof organizationUsesMachineHours>().mockResolvedValue(false),
  };
}

describe("usage billing", () => {
  beforeEach(() => vi.stubEnv("BILLING_ENABLED", "true"));
  afterEach(() => vi.unstubAllEnvs());

  it("charges a stopped sandbox period by its resources and duration", async () => {
    const deps = dependencies();

    await settleSandboxUsage(sandboxRow(), deps);

    // 600 seconds at 2 vCPU, 4 GiB memory, and 10 GiB disk.
    expect(deps.setCharge).toHaveBeenCalledWith("sandbox-usage-1", 16_860);
    expect(deps.track).toHaveBeenCalledWith({
      chargeMicros: 16_860,
      idempotencyKey: "sandbox-usage:sandbox-usage-1",
      organizationId: "organization-1",
      properties: { kind: "sandbox", workload: "automation", workloadId: "run-1" },
    });
    expect(deps.markBilled).toHaveBeenCalledWith("sandbox-usage-1");
  });

  it("reports sandbox time as machine hours on plans that include them", async () => {
    const deps = dependencies();
    deps.usesMachineHours.mockResolvedValue(true);

    await settleSandboxUsage(sandboxRow(), deps);

    expect(deps.setCharge).toHaveBeenCalledWith("sandbox-usage-1", 16_860);
    expect(deps.trackMachineHours).toHaveBeenCalledWith({
      hours: 1 / 6,
      idempotencyKey: "sandbox-usage:sandbox-usage-1",
      organizationId: "organization-1",
      properties: { kind: "sandbox", workload: "automation", workloadId: "run-1" },
    });
    expect(deps.track).not.toHaveBeenCalled();
    expect(deps.markBilled).toHaveBeenCalledWith("sandbox-usage-1");
  });

  it("leaves a sandbox period unbilled when its plan cannot be looked up", async () => {
    const deps = dependencies();
    deps.usesMachineHours.mockRejectedValue(new Error("Autumn is unavailable"));

    await expect(settleSandboxUsage(sandboxRow(), deps)).rejects.toThrow("Autumn");

    expect(deps.track).not.toHaveBeenCalled();
    expect(deps.trackMachineHours).not.toHaveBeenCalled();
    expect(deps.markBilled).not.toHaveBeenCalled();
  });

  it("prices a non-billable sandbox period without reporting it", async () => {
    const deps = dependencies();

    await settleSandboxUsage(sandboxRow({ billable: false }), deps);

    expect(deps.setCharge).toHaveBeenCalledWith("sandbox-usage-1", 16_860);
    expect(deps.track).not.toHaveBeenCalled();
    expect(deps.markBilled).toHaveBeenCalledWith("sandbox-usage-1");
  });

  it("does not report usage when billing is disabled", async () => {
    vi.stubEnv("BILLING_ENABLED", "false");
    const deps = dependencies();

    await settleSandboxUsage(sandboxRow(), deps);

    expect(deps.track).not.toHaveBeenCalled();
    expect(deps.markBilled).toHaveBeenCalledOnce();
  });

  it("leaves a sandbox period unbilled when reporting fails", async () => {
    const deps = dependencies();
    deps.track.mockRejectedValue(new Error("Autumn is unavailable"));

    await expect(settleSandboxUsage(sandboxRow(), deps)).rejects.toThrow("Autumn");

    expect(deps.markBilled).not.toHaveBeenCalled();
  });

  it("settles nothing when another process already closed the period", async () => {
    const deps = dependencies();
    deps.stop.mockResolvedValue(null as unknown as SandboxUsageRecord);

    await finishSandboxUsage("sandbox-usage-1", deps);

    expect(deps.track).not.toHaveBeenCalled();
  });

  it("prices agent model usage per request and applies the inference charge", async () => {
    const deps = dependencies();

    await settleAgentModelUsage(agentRow(), deps);

    // Two requests of 1,000 input and 100 output tokens cost 3,000 each.
    expect(deps.getPricing).toHaveBeenCalledWith("openai/gpt-5.4");
    expect(deps.setCharge).toHaveBeenCalledWith("agent-usage-1", 9_000);
    expect(deps.track).toHaveBeenCalledWith(expect.objectContaining({
      chargeMicros: 9_000,
      idempotencyKey: "agent-model-usage:agent-usage-1",
    }));
  });

  it("prices each request at its own long-context tier", async () => {
    const deps = dependencies();
    deps.getPricing.mockResolvedValue({
      input: "0.000001",
      input_tiers: [
        { cost: "0.000001", max: 200_000, min: 0 },
        { cost: "0.000002", min: 200_000 },
      ],
      output: "0",
    });
    const request = (inputTokens: number) => ({
      cachedInputTokens: 0,
      inputTokens,
      outputTokens: 0,
    });

    await recordAgentModelUsage(
      {
        ...agentRow({
          inputTokens: 310_000,
          outputTokens: 0,
          requestUsage: [request(300_000), request(10_000)],
        }),
        chargeMicros: undefined,
      } as never,
      deps,
    );

    // 300,000 tokens at the higher tier and 10,000 at the base tier, plus half.
    expect(deps.insert).toHaveBeenCalledWith(expect.objectContaining({ chargeMicros: 915_000 }));
  });

  it("keeps unpriced agent usage open for the retry pass", async () => {
    const deps = dependencies();
    deps.getPricing.mockResolvedValue(null);

    await recordAgentModelUsage({ ...agentRow(), chargeMicros: undefined } as never, deps);

    expect(deps.insert).toHaveBeenCalledWith(expect.objectContaining({ chargeMicros: null }));
    expect(deps.markBilled).not.toHaveBeenCalled();
  });

  it("settles unpriced usage that is not billed without retrying it", async () => {
    const deps = dependencies();
    deps.getPricing.mockResolvedValue(null);

    await settleAgentModelUsage(agentRow({ billable: false }), deps);

    expect(deps.setCharge).not.toHaveBeenCalled();
    expect(deps.markBilled).toHaveBeenCalledWith("agent-usage-1");
  });

  it("does not record a run that made no model requests", async () => {
    const deps = dependencies();

    await recordAgentModelUsage({ ...agentRow({ requests: 0 }), chargeMicros: undefined } as never, deps);

    expect(deps.insert).not.toHaveBeenCalled();
  });

  it("closes stale sandbox periods and retries unsettled rows", async () => {
    const now = Date.parse("2026-09-29T12:00:00.000Z");
    const settleSandbox = vi.fn().mockRejectedValueOnce(new Error("Autumn is unavailable"))
      .mockResolvedValue(undefined);
    const settleAgent = vi.fn().mockResolvedValue(undefined);
    const deps = {
      closeStaleSandboxes: vi.fn().mockResolvedValue(1),
      listAgentUsage: vi.fn().mockResolvedValue([agentRow()]),
      listSandboxUsage: vi.fn().mockResolvedValue([
        sandboxRow({ id: "sandbox-usage-1" }),
        sandboxRow({ id: "sandbox-usage-2" }),
      ]),
      markAgentUsageAttempted: vi.fn().mockResolvedValue(undefined),
      markSandboxUsageAttempted: vi.fn().mockResolvedValue(undefined),
      now: () => now,
      settleAgentUsage: settleAgent,
      settleSandboxUsage: settleSandbox,
    };

    await expect(settleUnbilledUsage(deps)).resolves.toEqual({
      failed: 1,
      settled: 2,
      staleSandboxes: 1,
    });
    expect(deps.closeStaleSandboxes).toHaveBeenCalledWith(5 * 60_000);
    expect(deps.listSandboxUsage).toHaveBeenCalledWith({
      limit: 200,
      stoppedAfter: new Date(now - 23 * 60 * 60_000),
      stoppedBefore: new Date(now - 60_000),
    });
    expect(deps.markSandboxUsageAttempted).toHaveBeenCalledWith(["sandbox-usage-1"]);
    expect(deps.markAgentUsageAttempted).toHaveBeenCalledWith([]);
  });

  it("stops reporting once a pass reaches its deadline", async () => {
    let now = Date.parse("2026-09-29T12:00:00.000Z");
    const settleSandbox = vi.fn(async () => {
      now += 6 * 60_000;
    });
    const deps = {
      closeStaleSandboxes: vi.fn().mockResolvedValue(0),
      listAgentUsage: vi.fn().mockResolvedValue([agentRow()]),
      listSandboxUsage: vi.fn().mockResolvedValue([
        sandboxRow({ id: "sandbox-usage-1" }),
        sandboxRow({ id: "sandbox-usage-2" }),
        sandboxRow({ id: "sandbox-usage-3" }),
      ]),
      markAgentUsageAttempted: vi.fn().mockResolvedValue(undefined),
      markSandboxUsageAttempted: vi.fn().mockResolvedValue(undefined),
      now: () => now,
      settleAgentUsage: vi.fn().mockResolvedValue(undefined),
      settleSandboxUsage: settleSandbox,
    };

    await expect(settleUnbilledUsage(deps)).resolves.toMatchObject({ failed: 0, settled: 2 });
    expect(deps.settleAgentUsage).not.toHaveBeenCalled();
  });

  it("finds the start of the usage period", () => {
    const now = new Date("2026-09-29T12:00:00.000Z");
    expect(usagePeriodStart({
      nextResetAt: Date.parse("2026-10-14T00:00:00.000Z"),
      periodStart: Date.parse("2026-09-14T00:00:00.000Z"),
    }, now)).toEqual(new Date("2026-09-14T00:00:00.000Z"));
    expect(usagePeriodStart({
      nextResetAt: Date.parse("2026-10-03T00:00:00.000Z"),
      periodStart: null,
    }, now)).toEqual(new Date("2026-09-03T00:00:00.000Z"));
    expect(usagePeriodStart({ nextResetAt: null, periodStart: null }, now))
      .toEqual(new Date("2026-09-01T00:00:00.000Z"));
  });

  it("clamps the period start to the end of a shorter month", () => {
    expect(usagePeriodStart({
      nextResetAt: Date.parse("2027-03-31T00:00:00.000Z"),
      periodStart: null,
    })).toEqual(new Date("2027-02-28T00:00:00.000Z"));
  });

  it("retries pricing with the stored per-request usage", async () => {
    const deps = dependencies();
    deps.getPricing.mockResolvedValue({
      input: "0.000001",
      input_tiers: [
        { cost: "0.000001", max: 200_000, min: 0 },
        { cost: "0.000002", min: 200_000 },
      ],
      output: "0",
    });
    const request = (inputTokens: number) => ({
      cachedInputTokens: 0,
      inputTokens,
      outputTokens: 0,
    });

    await settleAgentModelUsage(agentRow({
      inputTokens: 310_000,
      outputTokens: 0,
      requestUsage: [request(300_000), request(10_000)],
    }), deps);

    expect(deps.setCharge).toHaveBeenCalledWith("agent-usage-1", 915_000);
  });
});
