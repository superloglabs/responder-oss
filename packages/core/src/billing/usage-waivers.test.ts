import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UncreditedUsage } from "../db/usage-waivers.js";
import {
  creditWaivedUsage,
  usageWaiverStart,
  waiveAutomationRunUsage,
  waiveJobUsage,
} from "./usage-waivers.js";

function usage(overrides: Partial<UncreditedUsage> = {}): UncreditedUsage {
  return {
    balance: "usage_credit",
    chargeMicros: 3_000,
    hours: 0,
    id: "usage-1",
    kind: "automation_model",
    organizationId: "organization-1",
    properties: { model: "gpt-5.4", runId: "run-1" },
    ...overrides,
  };
}

const now = Date.parse("2026-10-07T12:00:00.000Z");

function dependencies() {
  return {
    creditCharge: vi.fn().mockResolvedValue(undefined),
    creditMachineHours: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([] as UncreditedUsage[]),
    markAttempted: vi.fn().mockResolvedValue(undefined),
    markCredited: vi.fn().mockResolvedValue(undefined),
    now: vi.fn(() => now),
  };
}

describe("usage waivers", () => {
  beforeEach(() => vi.stubEnv("BILLING_ENABLED", "true"));
  afterEach(() => vi.unstubAllEnvs());

  it("starts a waiver at the database's time, or this process's when it cannot answer", async () => {
    const databaseTime = new Date("2026-10-07T11:00:00.000Z");
    await expect(usageWaiverStart(vi.fn().mockResolvedValue(databaseTime))).resolves.toBe(databaseTime);

    const before = Date.now();
    const fallback = await usageWaiverStart(vi.fn().mockRejectedValue(new Error("offline")));
    expect(fallback.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("retries a run turn's waiver through a short database outage", async () => {
    const input = {
      leaseId: "lease-1",
      runId: "run-1",
      since: new Date("2026-10-07T11:00:00.000Z"),
    };
    const waive = vi.fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValue(true);

    await expect(waiveAutomationRunUsage(input, { retryDelaysMs: [0, 0], waive }))
      .resolves.toBe(true);

    expect(waive).toHaveBeenCalledTimes(2);
    expect(waive).toHaveBeenCalledWith(input);
  });

  it("reports a job waiver that keeps failing", async () => {
    const waive = vi.fn().mockRejectedValue(new Error("database unavailable"));

    await expect(waiveJobUsage({
      since: new Date("2026-10-07T11:00:00.000Z"),
      workload: "investigation",
      workloadId: "investigation-1",
    }, { retryDelaysMs: [0, 0], waive })).rejects.toThrow("database unavailable");

    expect(waive).toHaveBeenCalledTimes(3);
  });

  it("credits each charge back to the balance it was reported to", async () => {
    const deps = dependencies();
    deps.list.mockResolvedValue([
      usage(),
      usage({
        id: "agent-usage-1",
        kind: "agent_model",
        properties: { kind: "inference", model: "gpt-5.4", workload: "investigation", workloadId: "investigation-1" },
      }),
      usage({
        balance: "machine_hours",
        chargeMicros: 6_000,
        hours: 0.5,
        id: "sandbox-usage-1",
        kind: "sandbox",
        properties: { kind: "sandbox", workload: "automation", workloadId: "run-1" },
      }),
    ]);

    await expect(creditWaivedUsage(deps)).resolves.toEqual({ credited: 3, failed: 0 });

    expect(deps.list).toHaveBeenCalledWith({
      limit: 200,
      waivedAfter: new Date(now - 23 * 60 * 60_000),
    });
    expect(deps.creditCharge).toHaveBeenCalledWith({
      chargeMicros: 3_000,
      idempotencyKey: "automation-usage-credit:usage-1",
      organizationId: "organization-1",
      properties: { model: "gpt-5.4", runId: "run-1" },
    });
    expect(deps.creditCharge).toHaveBeenCalledWith({
      chargeMicros: 3_000,
      idempotencyKey: "agent-model-usage-credit:agent-usage-1",
      organizationId: "organization-1",
      properties: { kind: "inference", model: "gpt-5.4", workload: "investigation", workloadId: "investigation-1" },
    });
    expect(deps.creditMachineHours).toHaveBeenCalledExactlyOnceWith({
      hours: 0.5,
      idempotencyKey: "sandbox-usage-credit:sandbox-usage-1",
      organizationId: "organization-1",
      properties: { kind: "sandbox", workload: "automation", workloadId: "run-1" },
    });
    expect(deps.markCredited).toHaveBeenCalledWith("automation_model", "usage-1");
    expect(deps.markCredited).toHaveBeenCalledWith("agent_model", "agent-usage-1");
    expect(deps.markCredited).toHaveBeenCalledWith("sandbox", "sandbox-usage-1");
  });

  it("marks usage that was settled without a charge credited without reporting it", async () => {
    const deps = dependencies();
    deps.list.mockResolvedValue([usage({ balance: null, id: "sandbox-usage-1", kind: "sandbox" })]);

    await expect(creditWaivedUsage(deps)).resolves.toEqual({ credited: 1, failed: 0 });

    expect(deps.creditCharge).not.toHaveBeenCalled();
    expect(deps.creditMachineHours).not.toHaveBeenCalled();
    expect(deps.markCredited).toHaveBeenCalledWith("sandbox", "sandbox-usage-1");
  });

  it("leaves waived usage uncredited while billing is disabled", async () => {
    vi.stubEnv("BILLING_ENABLED", "false");
    const deps = dependencies();
    deps.list.mockResolvedValue([usage()]);

    await expect(creditWaivedUsage(deps)).resolves.toEqual({ credited: 0, failed: 0 });

    expect(deps.list).not.toHaveBeenCalled();
    expect(deps.creditCharge).not.toHaveBeenCalled();
    expect(deps.markCredited).not.toHaveBeenCalled();
  });

  it("records failed credits so the next pass tries newer ones first", async () => {
    const deps = dependencies();
    const failing = usage();
    deps.list.mockResolvedValue([failing, usage({ id: "usage-2" })]);
    deps.creditCharge.mockRejectedValueOnce(new Error("Autumn is unavailable"));

    await expect(creditWaivedUsage(deps)).resolves.toEqual({ credited: 1, failed: 1 });

    expect(deps.markCredited).toHaveBeenCalledExactlyOnceWith("automation_model", "usage-2");
    expect(deps.markAttempted).toHaveBeenCalledWith([failing]);
  });

  it("stops crediting once a pass reaches its deadline", async () => {
    const deps = dependencies();
    deps.list.mockResolvedValue([usage(), usage({ id: "usage-2" })]);
    deps.now
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now)
      .mockReturnValue(now + 10 * 60_000);

    await expect(creditWaivedUsage(deps)).resolves.toEqual({ credited: 1, failed: 0 });
    expect(deps.markAttempted).not.toHaveBeenCalled();
  });
});
