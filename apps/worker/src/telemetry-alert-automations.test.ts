import { describe, expect, it, vi } from "vitest";
import { startAlertAutomations, type AlertAutomationDependencies } from "./telemetry-alert-automations.js";

const input = {
  body: ":rotating_light: **Checkout errors** is firing.",
  channelId: "C1",
  episodeId: "episode-1",
  integrationAccountId: "account-1",
  organizationId: "org-1",
  timestamp: "1790000000.000100",
  title: "Checkout errors is firing",
};

function dependencies(overrides: Partial<AlertAutomationDependencies> = {}) {
  const dependencies: AlertAutomationDependencies = {
    abandon: vi.fn(async () => true),
    begin: vi.fn(async ({ automationId }) => ({ created: true, organizationId: "org-1", runId: `run-${automationId}` })),
    find: vi.fn(async () => [
      { automationId: "triage", integrationAccountId: "account-1", mentioned: false, organizationId: "org-1", startsRun: true },
      { automationId: "mentions-only", integrationAccountId: "account-1", mentioned: false, organizationId: "org-1", startsRun: false },
      { automationId: "other-org", integrationAccountId: "account-2", mentioned: false, organizationId: "org-2", startsRun: true },
    ]),
    identity: vi.fn(async () => ({ appId: "A-SUPERLOG", botUserId: "U-BOT", teamId: "T1" })),
    queue: vi.fn(async () => undefined),
    ...overrides,
  };
  return dependencies;
}

describe("startAlertAutomations", () => {
  it("starts the workspace's automations on the alert, threaded under it", async () => {
    const deps = dependencies();

    expect(await startAlertAutomations(input, deps)).toBe(1);
    expect(deps.find).toHaveBeenCalledWith({
      authorIds: ["A-SUPERLOG", "U-BOT"],
      channelId: "C1",
      eventType: "message",
      ownMessage: true,
      teamId: "T1",
      text: input.body,
      timestamp: input.timestamp,
    });
    expect(deps.begin).toHaveBeenCalledTimes(1);
    expect(deps.begin).toHaveBeenCalledWith({
      automationId: "triage",
      trigger: {
        attributes: {
          authorId: "A-SUPERLOG",
          authorName: "Superlog",
          authorType: "app",
          channelId: "C1",
          mentioned: false,
          teamId: "T1",
          threadTimestamp: input.timestamp,
          timestamp: input.timestamp,
        },
        body: input.body,
        externalEventId: "telemetry-alert-episode:episode-1:triage",
        provider: "slack",
        sourceUrl: "https://slack.com/archives/C1/p1790000000000100",
        title: input.title,
      },
    });
    expect(deps.queue).toHaveBeenCalledWith({ organizationId: "org-1", runId: "run-triage" });
  });

  it("does not queue a run that already exists for the episode", async () => {
    const deps = dependencies({ begin: vi.fn(async () => ({ created: false, organizationId: "org-1", runId: "run-1" })) });

    expect(await startAlertAutomations(input, deps)).toBe(0);
    expect(deps.queue).not.toHaveBeenCalled();
  });

  it("removes a run whose job could not be queued, and goes on to the next", async () => {
    const deps = dependencies({
      find: vi.fn(async () => [
        { automationId: "a", integrationAccountId: "account-1", mentioned: false, organizationId: "org-1", startsRun: true },
        { automationId: "b", integrationAccountId: "account-1", mentioned: false, organizationId: "org-1", startsRun: true },
      ]),
      queue: vi.fn(async ({ runId }) => {
        if (runId === "run-a") throw new Error("queue down");
      }),
    });

    expect(await startAlertAutomations(input, deps)).toBe(1);
    expect(deps.abandon).toHaveBeenCalledWith("run-a");
  });

  it("does nothing when the Slack connection is gone", async () => {
    const deps = dependencies({ identity: vi.fn(async () => null) });

    expect(await startAlertAutomations(input, deps)).toBe(0);
    expect(deps.find).not.toHaveBeenCalled();
  });
});
