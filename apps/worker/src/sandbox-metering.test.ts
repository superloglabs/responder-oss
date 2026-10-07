import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSandboxMeter, type SandboxMeterInput } from "./sandbox-metering.js";

const input: SandboxMeterInput = {
  billable: true,
  organizationId: "organization-1",
  snapshot: true,
  workload: "investigation",
  workloadId: "investigation-1",
};

function dependencies() {
  return {
    finish: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue("usage-1"),
  };
}

describe("sandbox meter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("records the snapshot's resources and renews the period each minute", async () => {
    const deps = dependencies();

    const meter = startSandboxMeter(input, deps);
    await vi.advanceTimersByTimeAsync(125_000);
    await meter.stop();

    expect(deps.start).toHaveBeenCalledWith({
      billable: true,
      cpu: 2,
      diskGiB: 10,
      memoryGiB: 4,
      organizationId: "organization-1",
      workload: "investigation",
      workloadId: "investigation-1",
    });
    expect(deps.heartbeat).toHaveBeenCalledTimes(2);
    expect(deps.finish).toHaveBeenCalledWith("usage-1", {});
  });

  it("stops a period as waived for work that failed", async () => {
    const deps = dependencies();

    await startSandboxMeter(input, deps).stop({ waived: true });

    expect(deps.finish).toHaveBeenCalledWith("usage-1", { waived: true });
  });

  it("stops once and renews nothing after stopping", async () => {
    const deps = dependencies();

    const meter = startSandboxMeter(input, deps);
    await Promise.all([meter.stop(), meter.stop()]);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(deps.finish).toHaveBeenCalledOnce();
    expect(deps.heartbeat).not.toHaveBeenCalled();
  });

  it("never fails the sandbox's work when metering fails", async () => {
    const deps = dependencies();
    deps.start.mockRejectedValue(new Error("database unavailable"));

    const meter = startSandboxMeter(input, deps);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(meter.stop()).resolves.toBeUndefined();

    expect(deps.heartbeat).not.toHaveBeenCalled();
    expect(deps.finish).not.toHaveBeenCalled();
  });

  it("logs a failed stop for the retry pass", async () => {
    const deps = dependencies();
    deps.finish.mockRejectedValue(new Error("Autumn is unavailable"));

    await expect(startSandboxMeter(input, deps).stop()).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("sandbox_usage_stop_failed"));
  });
});
