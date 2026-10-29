import type { BatchObservableResult, Meter, ObservableGauge } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import { startQueueHealthMetrics } from "./queue-health-metrics.js";

function fakeMeter() {
  const gauges = new Map<ObservableGauge, string>();
  let callback: ((result: BatchObservableResult) => Promise<void> | void) | undefined;
  const meter = {
    addBatchObservableCallback: vi.fn((registered) => {
      callback = registered;
    }),
    createObservableGauge: vi.fn((name: string) => {
      const gauge = {} as ObservableGauge;
      gauges.set(gauge, name);
      return gauge;
    }),
  } as unknown as Meter;
  async function collect() {
    const observed: Array<[string, number, Record<string, unknown> | undefined]> = [];
    await callback?.({
      observe: (gauge: ObservableGauge, value: number, attributes?: Record<string, unknown>) => {
        observed.push([gauges.get(gauge) ?? "unknown", value, attributes]);
      },
    } as BatchObservableResult);
    return observed;
  }
  return { collect, meter };
}

describe("queue health metrics", () => {
  it("reports automation run and job queue health", async () => {
    const { collect, meter } = fakeMeter();
    startQueueHealthMetrics(async () => ({
      automationRuns: {
        finished: { failed: 2, succeeded: 7, usage_limit_reached: 3 },
        leaseExpired: 1,
        oldestPendingSeconds: 540,
        orphaned: 3,
        pending: 4,
      },
      jobs: [
        {
          failed: 5,
          lastCompletedSeconds: 30,
          oldestQueuedSeconds: 600,
          queue: "responder-automation-runs-v2",
          queued: 4,
        },
        {
          failed: 0,
          lastCompletedSeconds: null,
          oldestQueuedSeconds: 0,
          queue: "responder-gcp-project-setup-v1",
          queued: 0,
        },
      ],
    }), meter);

    const observed = await collect();
    const automationQueue = { "messaging.destination.name": "responder-automation-runs-v2" };
    const gcpQueue = { "messaging.destination.name": "responder-gcp-project-setup-v1" };
    expect(observed).toEqual([
      ["responder.automation_runs.pending", 4, undefined],
      ["responder.automation_runs.pending.oldest_age", 540, undefined],
      ["responder.automation_runs.lease_expired", 1, undefined],
      ["responder.automation_runs.orphaned", 3, undefined],
      ["responder.automation_runs.finished", 7, { "automation_run.status": "succeeded" }],
      ["responder.automation_runs.finished", 2, { "automation_run.status": "failed" }],
      ["responder.automation_runs.finished", 3, { "automation_run.status": "usage_limit_reached" }],
      ["responder.automation_runs.finished", 0, { "automation_run.status": "cancelled" }],
      ["responder.jobs.queued", 4, automationQueue],
      ["responder.jobs.queued.oldest_age", 600, automationQueue],
      ["responder.jobs.failed", 5, automationQueue],
      ["responder.jobs.last_completed.age", 30, automationQueue],
      ["responder.jobs.queued", 0, gcpQueue],
      ["responder.jobs.queued.oldest_age", 0, gcpQueue],
      ["responder.jobs.failed", 0, gcpQueue],
    ]);
  });

  it("records nothing when the database cannot be read", async () => {
    const { collect, meter } = fakeMeter();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    startQueueHealthMetrics(async () => {
      throw new Error("connect ECONNREFUSED");
    }, meter);

    await expect(collect()).resolves.toEqual([]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("queue_health_read_failed"));
    error.mockRestore();
  });

  it("skips a collection while the previous read is still running", async () => {
    const { collect, meter } = fakeMeter();
    let finish: (() => void) | undefined;
    const read = vi.fn(
      () => new Promise<never>((_, reject) => {
        finish = () => reject(new Error("canceling statement due to statement timeout"));
      }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      startQueueHealthMetrics(read, meter);
      const first = collect();
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(first).resolves.toEqual([]);
      await expect(collect()).resolves.toEqual([]);
      expect(read).toHaveBeenCalledTimes(1);

      finish?.();
      await vi.advanceTimersByTimeAsync(0);
      void collect();
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      error.mockRestore();
    }
  });
});
