import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeInvestigationRun,
  deliverPersistedInvestigationAfterFailure,
} from "./investigation-completion.js";

describe("investigation completion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts Slack delivery only after the investigation is complete", async () => {
    const order: string[] = [];
    const complete = vi.fn(async () => {
      order.push("complete");
    });
    const deliver = vi.fn(async () => {
      order.push("deliver");
      return [];
    });
    const completeReplay = vi.fn(async () => {
      order.push("complete-replay");
    });

    await expect(
      completeInvestigationRun(
        {
          deliveryRunId: "job-id",
          investigationId: "investigation-id",
          replay: false,
          report: "Final report",
        },
        { complete, completeReplay, deliver },
      ),
    ).resolves.toEqual([]);

    expect(order).toEqual(["complete", "deliver"]);
    expect(deliver).toHaveBeenCalledWith("investigation-id", "job-id");
    expect(completeReplay).not.toHaveBeenCalled();
  });

  it("does not deliver replay investigations to Slack", async () => {
    const complete = vi.fn().mockResolvedValue(undefined);
    const completeReplay = vi.fn().mockResolvedValue(undefined);
    const deliver = vi.fn().mockResolvedValue([]);

    await completeInvestigationRun(
      {
        deliveryRunId: "job-id",
        investigationId: "replay-id",
        replay: true,
        report: "Replay report",
      },
      { complete, completeReplay, deliver },
    );

    expect(deliver).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(completeReplay).toHaveBeenCalledWith("replay-id", "Replay report");
  });

  it("logs completion failures with investigation context", async () => {
    const error = new Error("database unavailable");
    const complete = vi.fn().mockRejectedValue(error);
    const completeReplay = vi.fn().mockResolvedValue(undefined);
    const deliver = vi.fn().mockResolvedValue([]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      completeInvestigationRun(
        {
          deliveryRunId: "job-id",
          investigationId: "investigation-id",
          replay: false,
          report: "Final report",
        },
        { complete, completeReplay, deliver },
      ),
    ).rejects.toBe(error);

    expect(JSON.parse(String(consoleError.mock.calls[0]?.[0]))).toEqual({
      error: "database unavailable",
      event: "investigation_completion_failed",
      investigationId: "investigation-id",
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("logs atomic replay completion failures with investigation context", async () => {
    const error = new Error("database unavailable");
    const complete = vi.fn().mockResolvedValue(undefined);
    const completeReplay = vi.fn().mockRejectedValue(error);
    const deliver = vi.fn().mockResolvedValue([]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      completeInvestigationRun(
        {
          deliveryRunId: "job-id",
          investigationId: "replay-id",
          replay: true,
          report: "Replay report",
        },
        { complete, completeReplay, deliver },
      ),
    ).rejects.toBe(error);

    expect(JSON.parse(String(consoleError.mock.calls[0]?.[0]))).toEqual({
      error: "database unavailable",
      event: "investigation_replay_completion_failed",
      investigationId: "replay-id",
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("delivers a persisted report when the agent fails after submission", async () => {
    const deliver = vi.fn().mockResolvedValue([]);

    await deliverPersistedInvestigationAfterFailure(
      {
        deliveryRunId: "job-id",
        investigationFailed: false,
        investigationId: "investigation-id",
        replay: false,
      },
      deliver,
    );

    expect(deliver).toHaveBeenCalledWith("investigation-id", "job-id");
  });

  it("delivers the persisted report when a completed job is recovered", async () => {
    const deliver = vi.fn().mockResolvedValue([]);

    await expect(
      deliverPersistedInvestigationAfterFailure(
        {
          deliveryRunId: "job-id",
          investigationFailed: false,
          investigationId: "investigation-id",
          replay: false,
        },
        deliver,
      ),
    ).resolves.toEqual([]);

    expect(deliver).toHaveBeenCalledWith("investigation-id", "job-id");
  });

  it("does not deliver a recovered replay investigation", async () => {
    const deliver = vi.fn().mockResolvedValue([]);

    await expect(
      deliverPersistedInvestigationAfterFailure(
        {
          deliveryRunId: "job-id",
          investigationFailed: false,
          investigationId: "replay-id",
          replay: true,
        },
        deliver,
      ),
    ).resolves.toEqual([]);

    expect(deliver).not.toHaveBeenCalled();
  });
});
