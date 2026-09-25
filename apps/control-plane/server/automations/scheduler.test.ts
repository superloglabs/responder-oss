import { beforeEach, describe, expect, it, vi } from "vitest";
import { findDueScheduledAutomations } from "@responder/core/db/automations";
import { queueAutomationRun } from "./queue.js";
import { runDueScheduledAutomations } from "./scheduler.js";

vi.mock("@responder/core/db/automations", () => ({
  findDueScheduledAutomations: vi.fn(),
  scheduleExternalEventId: (scheduledFor: Date) => `schedule:${scheduledFor.toISOString()}`,
}));
vi.mock("./queue.js", () => ({ queueAutomationRun: vi.fn() }));

const scheduledFor = new Date("2026-09-21T08:00:00.000Z");
const trigger = { frequency: "weekly", hour: 9, kind: "schedule", timezone: "Europe/London", weekday: 1 } as const;

describe("automation scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("queues one run per due slot with the slot as the event ID", async () => {
    vi.mocked(findDueScheduledAutomations).mockResolvedValue([{ automationId: "automation-1", scheduledFor, trigger }]);
    vi.mocked(queueAutomationRun).mockResolvedValue({ duplicate: false, jobId: "job-1", runId: "run-1" });
    const now = new Date("2026-09-21T08:00:30.000Z");

    await runDueScheduledAutomations(now);

    expect(findDueScheduledAutomations).toHaveBeenCalledWith(now);
    expect(queueAutomationRun).toHaveBeenCalledWith({
      automationId: "automation-1",
      trigger: {
        attributes: { frequency: "weekly", scheduledFor: scheduledFor.toISOString(), timezone: "Europe/London" },
        body: `Scheduled run: Mondays at 09:00 (Europe/London). This run is for ${scheduledFor.toISOString()}.`,
        externalEventId: `schedule:${scheduledFor.toISOString()}`,
        provider: "schedule",
        title: "Weekly run",
      },
    });
  });

  it("keeps queueing other automations when one fails", async () => {
    vi.mocked(findDueScheduledAutomations).mockResolvedValue([
      { automationId: "automation-1", scheduledFor, trigger },
      { automationId: "automation-2", scheduledFor, trigger },
    ]);
    vi.mocked(queueAutomationRun)
      .mockRejectedValueOnce(new Error("Automation worker is unavailable"))
      .mockResolvedValueOnce({ duplicate: false, jobId: "job-2", runId: "run-2" });

    await runDueScheduledAutomations(new Date("2026-09-21T08:00:30.000Z"));

    expect(queueAutomationRun).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("scheduled_automation_failed"));
  });
});
