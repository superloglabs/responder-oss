import { afterEach, describe, expect, it, vi } from "vitest";
import { investigationQueue } from "@responder/core/jobs";
import { maintainLegacyInvestigationHeartbeat } from "./legacy-job-heartbeat.js";

describe("legacy investigation heartbeat rollout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maintains a heartbeat after fetching a pre-rollout job", async () => {
    vi.useFakeTimers();
    const executeSql = vi.fn().mockResolvedValue({ rows: [{ id: "job-id" }] });
    const touch = vi.fn().mockResolvedValue({ affected: 1 });
    const boss = {
      emit: vi.fn(),
      getDb: () => ({ executeSql }),
      touch,
    } as never;

    const stop = await maintainLegacyInvestigationHeartbeat(boss, {
      heartbeatSeconds: null,
      id: "job-id",
    });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(executeSql).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE pgboss.job"),
      [investigationQueue, "job-id", 60],
    );
    expect(touch).toHaveBeenCalledWith(investigationQueue, "job-id");
    stop();
  });

  it("stays dormant for jobs created with the queue heartbeat", async () => {
    const executeSql = vi.fn();
    const touch = vi.fn();

    const stop = await maintainLegacyInvestigationHeartbeat({
      getDb: () => ({ executeSql }),
      touch,
    } as never, {
      heartbeatSeconds: 60,
      id: "job-id",
    });

    stop();
    expect(executeSql).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
  });
});
