import { describe, expect, it, vi } from "vitest";
import type { DueTelemetryAlert, OpenTelemetryAlertEpisode } from "@responder/core/db/telemetry-alerts";
import { checkDueTelemetryAlerts, checkTelemetryAlert, type TelemetryAlertDependencies } from "./telemetry-alerts.js";

const now = new Date("2026-10-14T12:00:00.000Z");
const slack = { channelId: "C123", integrationAccountId: "00000000-0000-4000-8000-0000000000aa" };

const alert: DueTelemetryAlert = {
  aggregation: "count",
  comparator: "gt",
  field: null,
  createdAt: now.toISOString(),
  enabled: true,
  evaluationIntervalSeconds: 60,
  filter: { severity: "error" },
  groupBy: null,
  groupMode: "single",
  id: "alert-1",
  lastError: null,
  lastEvaluatedAt: null,
  metricName: null,
  name: "Checkout errors",
  notificationsPaused: false,
  organizationId: "org-1",
  slack,
  source: "logs",
  threshold: 10,
  updatedAt: now.toISOString(),
  windowMinutes: 5,
};

function episode(overrides: Partial<OpenTelemetryAlertEpisode> = {}): OpenTelemetryAlertEpisode {
  return {
    groupKey: "",
    id: "episode-1",
    notificationsPaused: false,
    peakValue: 20,
    slackChannelId: slack.channelId,
    slackIntegrationAccountId: slack.integrationAccountId,
    slackMessageTs: "1700000000.000100",
    startedAt: new Date(now.getTime() - 30 * 60_000),
    ...overrides,
  };
}

function dependencies(overrides: Partial<TelemetryAlertDependencies> = {}) {
  const dependencies: TelemetryAlertDependencies = {
    claim: vi.fn(async () => [alert]),
    client: () => ({}) as never,
    continueEpisode: vi.fn(async () => undefined),
    markRecoveryNotified: vi.fn(async () => undefined),
    now: () => now,
    openEpisode: vi.fn(async () => episode({ slackMessageTs: null })),
    openEpisodes: vi.fn(async () => []),
    origin: "https://us.superlog.sh",
    post: vi.fn<TelemetryAlertDependencies["post"]>(async (input) =>
      input.notifications.map((notification) => ({ notification, timestamp: "1700000000.000200" })),
    ),
    recordCheck: vi.fn(async () => undefined),
    resolveEpisode: vi.fn(async () => true),
    setMessage: vi.fn(async () => undefined),
    unannouncedRecoveries: vi.fn(async () => []),
    values: vi.fn(async () => [{ group: "", value: 25 }]),
    ...overrides,
  };
  return dependencies;
}

describe("checkTelemetryAlert", () => {
  it("opens an episode and announces it in the alert's channel", async () => {
    const deps = dependencies();

    await checkTelemetryAlert(alert, {} as never, deps);

    expect(deps.values).toHaveBeenCalledWith(expect.anything(), "org-1", alert, now);
    expect(deps.openEpisode).toHaveBeenCalledWith({
      alertId: "alert-1",
      groupKey: "",
      ruleUpdatedAt: alert.updatedAt,
      slack,
      value: 25,
    });
    expect(deps.post).toHaveBeenCalledWith(expect.objectContaining({
      markdown: expect.stringContaining("**Checkout errors** is firing"),
      notifications: [{ ...slack, kind: "slack" }],
      organizationId: "org-1",
      seed: "telemetry-alert-episode:episode-1:firing",
    }));
    expect(vi.mocked(deps.post).mock.calls[0]![0].markdown).toContain("https://us.superlog.sh/alerts/alert-1");
    expect(deps.setMessage).toHaveBeenCalledWith("episode-1", "1700000000.000200");
    expect(deps.recordCheck).toHaveBeenCalledWith("alert-1", null);
  });

  it("starts the channel's automations on the posted alert", async () => {
    const startAutomations = vi.fn(async () => 1);
    const deps = dependencies({ startAutomations });

    await checkTelemetryAlert(alert, {} as never, deps);

    expect(startAutomations).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "C123",
      episodeId: "episode-1",
      integrationAccountId: slack.integrationAccountId,
      organizationId: "org-1",
      timestamp: "1700000000.000200",
      title: "Checkout errors is firing",
    }));
  });

  it("posts nothing for an episode opened while notifications were paused", async () => {
    const startAutomations = vi.fn(async () => 1);
    const opened = dependencies({ openEpisode: vi.fn(async () => episode({ notificationsPaused: true, slackMessageTs: null })), startAutomations });
    await checkTelemetryAlert(alert, {} as never, opened);
    expect(opened.openEpisode).toHaveBeenCalled();

    // Still firing after notifications resume: it is not announced late.
    const continued = dependencies({
      openEpisodes: vi.fn(async () => [episode({ notificationsPaused: true, slackMessageTs: null })]),
      startAutomations,
    });
    await checkTelemetryAlert(alert, {} as never, continued);
    expect(continued.continueEpisode).toHaveBeenCalled();

    // Recovered: nothing to reply to, so the recovery is settled quietly.
    const recovered = dependencies({
      openEpisodes: vi.fn(async () => [episode({ notificationsPaused: true, slackMessageTs: null })]),
      values: vi.fn(async () => [{ group: "", value: 4 }]),
    });
    await checkTelemetryAlert(alert, {} as never, recovered);
    expect(recovered.markRecoveryNotified).toHaveBeenCalledWith("episode-1");

    for (const deps of [opened, continued, recovered]) {
      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.recordCheck).toHaveBeenCalledWith("alert-1", null);
    }
    expect(startAutomations).not.toHaveBeenCalled();
  });

  it("posts nothing while the workspace is paused, even for episodes opened before", async () => {
    const paused = { ...alert, notificationsPaused: true };
    const startAutomations = vi.fn(async () => 1);
    const retried = dependencies({ openEpisodes: vi.fn(async () => [episode({ slackMessageTs: null })]), startAutomations });
    await checkTelemetryAlert(paused, {} as never, retried);

    const recovered = dependencies({
      openEpisodes: vi.fn(async () => [episode()]),
      values: vi.fn(async () => [{ group: "", value: 4 }]),
    });
    await checkTelemetryAlert(paused, {} as never, recovered);
    expect(recovered.resolveEpisode).toHaveBeenCalledWith("episode-1", 4);
    // Left for the reply once the pause ends.
    expect(recovered.markRecoveryNotified).not.toHaveBeenCalled();

    for (const deps of [retried, recovered]) expect(deps.post).not.toHaveBeenCalled();
    expect(startAutomations).not.toHaveBeenCalled();
  });

  it("updates a firing episode without posting again", async () => {
    const deps = dependencies({ openEpisodes: vi.fn(async () => [episode()]) });

    await checkTelemetryAlert(alert, {} as never, deps);

    expect(deps.continueEpisode).toHaveBeenCalledWith(episode(), "gt", 25);
    expect(deps.openEpisode).not.toHaveBeenCalled();
    expect(deps.post).not.toHaveBeenCalled();
  });

  it("retries an announcement that failed", async () => {
    const deps = dependencies({ openEpisodes: vi.fn(async () => [episode({ slackMessageTs: null })]) });

    await checkTelemetryAlert(alert, {} as never, deps);

    expect(deps.post).toHaveBeenCalledTimes(1);
    expect(deps.setMessage).toHaveBeenCalledWith("episode-1", "1700000000.000200");
  });

  it("posts the recovery in the episode's thread", async () => {
    const deps = dependencies({
      openEpisodes: vi.fn(async () => [episode()]),
      values: vi.fn(async () => [{ group: "", value: 4 }]),
    });

    await checkTelemetryAlert(alert, {} as never, deps);

    expect(deps.resolveEpisode).toHaveBeenCalledWith("episode-1", 4);
    expect(deps.post).toHaveBeenCalledWith(expect.objectContaining({
      markdown: expect.stringContaining("recovered after 30 minutes"),
      seed: "telemetry-alert-episode:episode-1:recovered",
      threadTimestamp: "1700000000.000100",
    }));
    expect(deps.markRecoveryNotified).toHaveBeenCalledWith("episode-1");
  });

  it("does not post a recovery for an episode another check already ended", async () => {
    const deps = dependencies({
      openEpisodes: vi.fn(async () => [episode()]),
      resolveEpisode: vi.fn(async () => false),
      values: vi.fn(async () => [{ group: "", value: 4 }]),
    });

    await checkTelemetryAlert(alert, {} as never, deps);

    expect(deps.post).not.toHaveBeenCalled();
  });

  it("retries recoveries whose reply failed earlier, and skips posting without a channel", async () => {
    const pending = { ...episode({ id: "episode-2" }), endedAt: new Date(now.getTime() - 60_000), lastValue: 3 };
    const deps = dependencies({
      unannouncedRecoveries: vi.fn(async () => [pending]),
      values: vi.fn(async () => [{ group: "", value: 1 }]),
    });

    await checkTelemetryAlert(alert, {} as never, deps);

    expect(deps.post).toHaveBeenCalledWith(expect.objectContaining({ seed: "telemetry-alert-episode:episode-2:recovered" }));

    const silent = dependencies({
      openEpisodes: vi.fn(async () => [episode({ slackChannelId: null, slackMessageTs: null })]),
      values: vi.fn(async () => [{ group: "", value: 1 }]),
    });
    await checkTelemetryAlert({ ...alert, slack: null }, {} as never, silent);
    expect(silent.post).not.toHaveBeenCalled();
    expect(silent.markRecoveryNotified).toHaveBeenCalledWith("episode-1");
  });

  it("announces at most ten new groups per check", async () => {
    let next = 0;
    const deps = dependencies({
      openEpisode: vi.fn(async ({ groupKey }) => episode({ groupKey, id: `episode-${(next += 1)}`, slackMessageTs: null })),
      values: vi.fn(async () => Array.from({ length: 12 }, (_, index) => ({ group: `service-${index}`, value: 50 }))),
    });

    await checkTelemetryAlert({ ...alert, groupBy: "service", groupMode: "per_group" }, {} as never, deps);

    expect(deps.openEpisode).toHaveBeenCalledTimes(12);
    expect(deps.post).toHaveBeenCalledTimes(10);
  });

  it("records a failed Slack post on the alert, so the app can show it", async () => {
    const deps = dependencies({
      post: vi.fn<TelemetryAlertDependencies["post"]>(async (input) =>
        input.notifications.map((notification) => ({ error: new Error("channel_not_found"), notification })),
      ),
    });

    await checkTelemetryAlert(alert, {} as never, deps);

    expect(deps.recordCheck).toHaveBeenCalledWith("alert-1", "Posting to Slack failed: channel_not_found");
    expect(deps.setMessage).not.toHaveBeenCalled();
  });

  it("counts a post without a message ID as failed", async () => {
    const deps = dependencies({
      post: vi.fn<TelemetryAlertDependencies["post"]>(async (input) =>
        input.notifications.map((notification) => ({ notification, timestamp: null })),
      ),
    });

    await checkTelemetryAlert(alert, {} as never, deps);

    expect(deps.recordCheck).toHaveBeenCalledWith("alert-1", "Posting to Slack failed: Slack did not return the message");
    expect(deps.setMessage).not.toHaveBeenCalled();
  });

  it("records a failed check and does not touch episodes", async () => {
    const deps = dependencies({ values: vi.fn(async () => { throw new Error("Timeout exceeded"); }) });

    await checkTelemetryAlert(alert, {} as never, deps);

    expect(deps.recordCheck).toHaveBeenCalledWith("alert-1", "Timeout exceeded");
    expect(deps.openEpisode).not.toHaveBeenCalled();
  });
});

describe("checkDueTelemetryAlerts", () => {
  it("does nothing without a telemetry store", async () => {
    const deps = dependencies({ client: () => null });

    expect(await checkDueTelemetryAlerts(deps)).toBe(0);
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it("checks every claimed alert", async () => {
    const deps = dependencies({ claim: vi.fn(async () => [alert, { ...alert, id: "alert-2" }]) });

    expect(await checkDueTelemetryAlerts(deps)).toBe(2);
    expect(deps.claim).toHaveBeenCalledWith(20);
    expect(deps.recordCheck).toHaveBeenCalledWith("alert-2", null);
  });
});
