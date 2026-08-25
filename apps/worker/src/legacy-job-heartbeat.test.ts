import { describe, expect, it, vi } from "vitest";
import { investigationQueue } from "@responder/core/jobs";
import { migrateLegacyInvestigationHeartbeats } from "./legacy-job-heartbeat.js";

describe("legacy investigation heartbeat rollout migration", () => {
  it("migrates queued legacy jobs before normal work starts", async () => {
    const executeSql = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await migrateLegacyInvestigationHeartbeats({
      getDb: () => ({ executeSql }),
    });

    expect(executeSql).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("state IN ('created', 'retry')"),
      [investigationQueue, 60],
    );
    expect(executeSql).toHaveBeenCalledTimes(2);
  });

  it("waits for the old task to hand an active job back", async () => {
    const executeSql = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "job-id" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const wait = vi.fn().mockResolvedValue(undefined);

    await migrateLegacyInvestigationHeartbeats(
      { getDb: () => ({ executeSql }) },
      { now: () => 0, wait },
    );

    expect(wait).toHaveBeenCalledWith(1_000);
    expect(executeSql).toHaveBeenCalledTimes(4);
  });

  it("adopts an abandoned active row after the ECS shutdown window", async () => {
    const executeSql = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "job-id" }] })
      .mockResolvedValueOnce({ rows: [] });

    await migrateLegacyInvestigationHeartbeats(
      { getDb: () => ({ executeSql }) },
      { graceMs: 0, now: () => 0 },
    );

    expect(executeSql).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("heartbeat_on = now()"),
      [investigationQueue, 60],
    );
  });
});
