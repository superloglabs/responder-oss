import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationModelUsageRecord } from "../db/automation-model-usage.js";
import type { SandboxUsageRecord } from "../db/sandbox-usage.js";
import { creditWaivedUsage, waiveAutomationRunUsage } from "./usage-waivers.js";

vi.mock("./usage-pricing.js", () => ({
  inferenceChargeMicros: (costMicros: number) => costMicros,
  sandboxChargeMicros: (_resources: unknown, seconds: number) => seconds * 10,
}));

function modelRow(overrides: Partial<AutomationModelUsageRecord> = {}): AutomationModelUsageRecord {
  return {
    cacheWriteTokens: 0,
    cachedInputTokens: 0,
    costMicros: 3_000,
    id: "usage-1",
    inferenceSource: "responder",
    inputTokens: 1_000,
    model: "gpt-5.4",
    organizationId: "organization-1",
    outputTokens: 100,
    provider: "openai",
    runId: "run-1",
    waived: true,
    ...overrides,
  };
}

function sandboxRow(overrides: Partial<SandboxUsageRecord> = {}): SandboxUsageRecord {
  return {
    billable: true,
    chargeMicros: 6_000,
    cpu: 2,
    diskGiB: 10,
    id: "sandbox-usage-1",
    memoryGiB: 4,
    organizationId: "organization-1",
    startedAt: new Date("2026-10-07T10:00:00.000Z"),
    stoppedAt: new Date("2026-10-07T10:30:00.000Z"),
    waived: true,
    workload: "automation",
    workloadId: "run-1",
    ...overrides,
  };
}

const now = Date.parse("2026-10-07T12:00:00.000Z");

function dependencies() {
  return {
    creditCharge: vi.fn().mockResolvedValue(undefined),
    creditMachineHours: vi.fn().mockResolvedValue(undefined),
    listModelUsage: vi.fn().mockResolvedValue([] as AutomationModelUsageRecord[]),
    listSandboxUsage: vi.fn().mockResolvedValue([] as SandboxUsageRecord[]),
    markModelUsageCredited: vi.fn().mockResolvedValue(undefined),
    markSandboxUsageCredited: vi.fn().mockResolvedValue(undefined),
    now: vi.fn(() => now),
    usesMachineHours: vi.fn().mockResolvedValue(false),
  };
}

describe("usage waivers", () => {
  beforeEach(() => vi.stubEnv("BILLING_ENABLED", "true"));
  afterEach(() => vi.unstubAllEnvs());

  it("waives a run's model requests and sandbox time since its turn started", async () => {
    const since = new Date("2026-10-07T11:00:00.000Z");
    const waiveModelUsage = vi.fn().mockResolvedValue(undefined);
    const waiveSandboxUsage = vi.fn().mockResolvedValue(undefined);

    await waiveAutomationRunUsage({ runId: "run-1", since }, { waiveModelUsage, waiveSandboxUsage });

    expect(waiveModelUsage).toHaveBeenCalledWith("run-1", since);
    expect(waiveSandboxUsage).toHaveBeenCalledWith({
      since,
      workload: "automation",
      workloadId: "run-1",
    });
  });

  it("credits reported model usage back to the usage credit", async () => {
    const deps = dependencies();
    deps.listModelUsage.mockResolvedValue([modelRow()]);

    await expect(creditWaivedUsage(deps)).resolves.toEqual({ credited: 1, failed: 0 });

    expect(deps.listModelUsage).toHaveBeenCalledWith({
      limit: 200,
      waivedAfter: new Date(now - 23 * 60 * 60_000),
    });
    expect(deps.creditCharge).toHaveBeenCalledWith({
      chargeMicros: 3_000,
      idempotencyKey: "automation-usage-credit:usage-1",
      organizationId: "organization-1",
      properties: { model: "gpt-5.4", runId: "run-1" },
    });
    expect(deps.markModelUsageCredited).toHaveBeenCalledWith("usage-1");
  });

  it("credits reported sandbox time to the balance the plan charges", async () => {
    const deps = dependencies();
    deps.listSandboxUsage.mockResolvedValue([
      sandboxRow(),
      sandboxRow({ id: "sandbox-usage-2", organizationId: "organization-2" }),
    ]);
    deps.usesMachineHours.mockImplementation(async (organizationId: string) =>
      organizationId === "organization-2");

    await expect(creditWaivedUsage(deps)).resolves.toEqual({ credited: 2, failed: 0 });

    expect(deps.creditCharge).toHaveBeenCalledWith(expect.objectContaining({
      chargeMicros: 6_000,
      idempotencyKey: "sandbox-usage-credit:sandbox-usage-1",
    }));
    expect(deps.creditMachineHours).toHaveBeenCalledWith(expect.objectContaining({
      hours: 0.5,
      idempotencyKey: "sandbox-usage-credit:sandbox-usage-2",
      organizationId: "organization-2",
    }));
    expect(deps.markSandboxUsageCredited).toHaveBeenCalledTimes(2);
  });

  it("leaves a failed credit for the next pass", async () => {
    const deps = dependencies();
    deps.listModelUsage.mockResolvedValue([modelRow(), modelRow({ id: "usage-2" })]);
    deps.creditCharge.mockRejectedValueOnce(new Error("Autumn is unavailable"));

    await expect(creditWaivedUsage(deps)).resolves.toEqual({ credited: 1, failed: 1 });

    expect(deps.markModelUsageCredited).toHaveBeenCalledExactlyOnceWith("usage-2");
  });

  it("marks usage credited without reporting when billing is disabled", async () => {
    vi.stubEnv("BILLING_ENABLED", "false");
    const deps = dependencies();
    deps.listModelUsage.mockResolvedValue([modelRow()]);
    deps.listSandboxUsage.mockResolvedValue([sandboxRow()]);

    await expect(creditWaivedUsage(deps)).resolves.toEqual({ credited: 2, failed: 0 });

    expect(deps.creditCharge).not.toHaveBeenCalled();
    expect(deps.usesMachineHours).not.toHaveBeenCalled();
    expect(deps.markModelUsageCredited).toHaveBeenCalledWith("usage-1");
    expect(deps.markSandboxUsageCredited).toHaveBeenCalledWith("sandbox-usage-1");
  });

  it("stops crediting once a pass reaches its deadline", async () => {
    const deps = dependencies();
    deps.listModelUsage.mockResolvedValue([modelRow(), modelRow({ id: "usage-2" })]);
    deps.now
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now)
      .mockReturnValue(now + 10 * 60_000);

    await expect(creditWaivedUsage(deps)).resolves.toEqual({ credited: 1, failed: 0 });
  });
});
