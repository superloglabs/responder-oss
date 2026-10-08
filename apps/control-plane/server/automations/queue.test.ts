import { afterEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
const db = vi.hoisted(() => ({
  abandonPendingAutomationRun: vi.fn(),
  addAutomationRunReply: vi.fn(),
  beginAutomationRun: vi.fn(),
  continueAutomationRun: vi.fn(),
  reopenAutomationRun: vi.fn(),
  setAutomationRunStatus: vi.fn(),
}));

vi.mock("../../../../packages/core/src/db/automations.js", () => db);
vi.mock("../../../../packages/core/src/jobs.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../packages/core/src/jobs.js")>(),
  createJobBoss: () => ({
    on: vi.fn(),
    send,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
  prepareWorkerQueues: vi.fn().mockResolvedValue(undefined),
}));

const {
  closeAutomationQueue,
  queueAutomationRun,
  queueAutomationRunFollowUp,
  queueAutomationRunReply,
} = await import("./queue.js");

const message = { authorId: "U1", authorName: "Ash", source: "slack" as const, text: "look again" };

afterEach(async () => {
  await closeAutomationQueue();
  vi.clearAllMocks();
});

describe("automation run queue", () => {
  it("groups a new run's job by its workspace", async () => {
    db.beginAutomationRun.mockResolvedValue({
      created: true,
      organizationId: "organization-1",
      runId: "run-1",
    });
    send.mockResolvedValue("job-1");

    await expect(queueAutomationRun({
      automationId: "automation-1",
      trigger: { body: "alert", externalEventId: "event-1", provider: "slack", title: "alert" },
    })).resolves.toEqual({ duplicate: false, jobId: "job-1", runId: "run-1" });
    expect(send).toHaveBeenCalledWith(
      "responder-automation-runs-v2",
      expect.objectContaining({ runId: "run-1" }),
      { group: { id: "organization-1" } },
    );
  });

  it("groups a follow-up's job by its workspace", async () => {
    db.continueAutomationRun.mockResolvedValue({ runId: "run-1" });
    send.mockResolvedValue("job-2");

    await queueAutomationRunFollowUp({
      message,
      organizationId: "organization-1",
      runId: "run-1",
    });
    expect(send).toHaveBeenCalledWith(
      "responder-automation-runs-v2",
      expect.objectContaining({ runId: "run-1" }),
      { group: { id: "organization-1" } },
    );
  });

  it("groups a Slack reply's job by the reopened run's workspace", async () => {
    db.addAutomationRunReply.mockResolvedValue(true);
    db.reopenAutomationRun.mockResolvedValue("organization-2");
    send.mockResolvedValue("job-3");

    await expect(queueAutomationRunReply({
      message: { ...message, externalEventId: "C1:1.2" },
      runId: "run-2",
    })).resolves.toBe("queued");
    expect(send).toHaveBeenCalledWith(
      "responder-automation-runs-v2",
      expect.objectContaining({ runId: "run-2" }),
      { group: { id: "organization-2" } },
    );
  });

  it("leaves a reply for the active turn when the run cannot reopen", async () => {
    db.addAutomationRunReply.mockResolvedValue(true);
    db.reopenAutomationRun.mockResolvedValue(null);

    await expect(queueAutomationRunReply({
      message: { ...message, externalEventId: "C1:1.3" },
      runId: "run-2",
    })).resolves.toBe("waiting");
    expect(send).not.toHaveBeenCalled();
  });

  it("fails a reopened run whose reply cannot be queued", async () => {
    db.addAutomationRunReply.mockResolvedValue(true);
    db.reopenAutomationRun.mockResolvedValue("organization-2");
    send.mockRejectedValueOnce(new Error("queue down"));

    await expect(queueAutomationRunReply({
      message: { ...message, externalEventId: "C1:1.4" },
      runId: "run-2",
    })).rejects.toThrow("Automation worker is unavailable");
    expect(db.setAutomationRunStatus).toHaveBeenCalledWith(expect.objectContaining({
      failureCategory: "queue_unavailable",
      runId: "run-2",
      status: "failed",
    }));
  });

  it("abandons a new run whose job cannot be queued", async () => {
    db.beginAutomationRun.mockResolvedValue({
      created: true,
      organizationId: "organization-1",
      runId: "run-3",
    });
    send.mockRejectedValueOnce(new Error("queue down"));

    await expect(queueAutomationRun({
      automationId: "automation-1",
      trigger: { body: "alert", externalEventId: "event-3", provider: "slack", title: "alert" },
    })).rejects.toThrow("Automation worker is unavailable");
    expect(db.abandonPendingAutomationRun).toHaveBeenCalledWith("run-3");
  });
});
