import { describe, expect, it, vi } from "vitest";
import { ClaudeRoutineFireError } from "@responder/core/claude-routines";
import type { DueTelemetryAlert, OpenTelemetryAlertEpisode } from "@responder/core/db/telemetry-alerts";
import { checkDueTelemetryAlerts, checkTelemetryAlert, type TelemetryAlertDependencies } from "./telemetry-alerts.js";

const now = new Date("2026-10-14T12:00:00.000Z");
const slack = { channelId: "C123", integrationAccountId: "00000000-0000-4000-8000-0000000000aa" };

const alert: DueTelemetryAlert = {
  aggregation: "count",
  claudeRoutineId: null,
  comparator: "gt",
  field: null,
  createdAt: now.toISOString(),
  description: null,
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
    claudeRoutineStartedAt: null,
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
    claimRoutine: vi.fn(async () => true),
    client: () => ({}) as never,
    continueEpisode: vi.fn(async () => undefined),
    finishRoutine: vi.fn(async () => undefined),
    markRecoveryNotified: vi.fn(async () => undefined),
    now: () => now,
    openEpisode: vi.fn(async () => episode({ slackMessageTs: null })),
    openEpisodes: vi.fn(async () => []),
    origin: "https://us.superlog.sh",
    post: vi.fn<TelemetryAlertDependencies["post"]>(async (input) =>
      input.notifications.map((notification) => ({ notification, timestamp: "1700000000.000200" })),
    ),
    recordCheck: vi.fn(async () => undefined),
    renderChart: vi.fn(async () => ({ altText: "Evaluation graph", png: Buffer.from("png") })),
    resolveEpisode: vi.fn(async () => true),
    setMessage: vi.fn(async () => undefined),
    startRoutine: vi.fn(async () => ({ sessionUrl: "https://claude.ai/code/session_01" })),
    unannouncedRecoveries: vi.fn(async () => []),
    values: vi.fn(async () => [{ group: "", value: 25 }]),
    ...overrides,
  };
  return dependencies;
}

describe("checkTelemetryAlert", () => {
  const routineId = "00000000-0000-4000-8000-0000000000bb";

  it("starts the alert's Claude routine once when an episode opens", async () => {
    const deps = dependencies();

    await checkTelemetryAlert({ ...alert, claudeRoutineId: routineId, description: "Roll back first." }, {} as never, deps);

    expect(deps.claimRoutine).toHaveBeenCalledWith("episode-1");
    expect(deps.startRoutine).toHaveBeenCalledWith({ organizationId: "org-1", routineId, text: expect.any(String) });
    const { text } = vi.mocked(deps.startRoutine).mock.calls[0]![0];
    expect(text).toContain('Superlog alert "Checkout errors" is firing.');
    expect(text).toContain("ERROR logs in the last 5 minutes: 25, above 10.");
    expect(text).toContain("Alert: https://us.superlog.sh/alerts/alert-1");
    expect(text).toContain("Roll back first.");
    expect(deps.finishRoutine).toHaveBeenCalledWith("episode-1", { sessionUrl: "https://claude.ai/code/session_01" });
    expect(deps.recordCheck).toHaveBeenCalledWith("alert-1", null);
  });

  it("starts the routine without a Slack channel", async () => {
    const deps = dependencies({ openEpisode: vi.fn(async () => episode({ slackChannelId: null, slackIntegrationAccountId: null, slackMessageTs: null })) });

    await checkTelemetryAlert({ ...alert, claudeRoutineId: routineId, slack: null }, {} as never, deps);

    expect(deps.post).not.toHaveBeenCalled();
    expect(deps.startRoutine).toHaveBeenCalledOnce();
  });

  it("does not start the routine again for a continuing episode or while paused", async () => {
    const started = dependencies({
      openEpisodes: vi.fn(async () => [episode({ claudeRoutineStartedAt: now })]),
    });
    await checkTelemetryAlert({ ...alert, claudeRoutineId: routineId }, {} as never, started);
    expect(started.startRoutine).not.toHaveBeenCalled();

    const paused = dependencies();
    await checkTelemetryAlert({ ...alert, claudeRoutineId: routineId, notificationsPaused: true }, {} as never, paused);
    expect(paused.startRoutine).not.toHaveBeenCalled();

    const claimed = dependencies({ claimRoutine: vi.fn(async () => false) });
    await checkTelemetryAlert({ ...alert, claudeRoutineId: routineId }, {} as never, claimed);
    expect(claimed.startRoutine).not.toHaveBeenCalled();
  });

  it("releases the claim only when the start certainly created no session", async () => {
    const limited = dependencies({
      startRoutine: vi.fn(async () => {
        throw new ClaudeRoutineFireError("The routine's hourly limit was reached", true);
      }),
    });
    await checkTelemetryAlert({ ...alert, claudeRoutineId: routineId }, {} as never, limited);
    expect(limited.finishRoutine).toHaveBeenCalledWith("episode-1", null);
    expect(limited.recordCheck).toHaveBeenCalledWith(
      "alert-1",
      "Starting the Claude routine failed: The routine's hourly limit was reached",
    );

    const timedOut = dependencies({
      startRoutine: vi.fn(async () => {
        throw new ClaudeRoutineFireError("Anthropic did not answer in time", false);
      }),
    });
    await checkTelemetryAlert({ ...alert, claudeRoutineId: routineId }, {} as never, timedOut);
    expect(timedOut.finishRoutine).not.toHaveBeenCalled();
  });

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
      handoff: { kind: "fix", sourceUrl: "https://us.superlog.sh/alerts/alert-1" },
      markdown: expect.stringContaining("**Checkout errors** is firing"),
      notifications: [{ ...slack, kind: "slack" }],
      organizationId: "org-1",
      seed: "telemetry-alert-episode:episode-1:firing",
    }));
    expect(vi.mocked(deps.post).mock.calls[0]![0].markdown).toContain("https://us.superlog.sh/alerts/alert-1");
    expect(deps.setMessage).toHaveBeenCalledWith("episode-1", "1700000000.000200");
    expect(deps.recordCheck).toHaveBeenCalledWith("alert-1", null);
  });

  it("posts the alert's description when it fires", async () => {
    const deps = dependencies();

    await checkTelemetryAlert({ ...alert, description: "Check the payment provider first." }, {} as never, deps);

    const posted = vi.mocked(deps.post).mock.calls[0]![0];
    expect(posted.markdown).toContain("Check the payment provider first.");
    expect(JSON.stringify(posted.imageLayout)).toContain("Check the payment provider first.");
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

describe("alert graph delivery", () => {
  it("includes the graph and suppresses link previews", async () => {
    const deps = dependencies();
    await checkTelemetryAlert(alert, {} as never, deps);
    expect(deps.renderChart).toHaveBeenCalledWith({ client: {}, groupKey: "", now, organizationId: "org-1", rule: alert });
    expect(deps.post).toHaveBeenCalledWith(expect.objectContaining({ image: { altText: "Evaluation graph", png: Buffer.from("png") }, unfurlLinks: false }));
  });

  it("still delivers and records the alert when chart rendering fails", async () => {
    const deps = dependencies({ renderChart: vi.fn().mockRejectedValue(new Error("query timed out")) });
    await checkTelemetryAlert(alert, {} as never, deps);
    expect(deps.post).toHaveBeenCalledWith(expect.objectContaining({ image: undefined }));
    expect(deps.setMessage).toHaveBeenCalledWith("episode-1", "1700000000.000200");
    expect(deps.recordCheck).toHaveBeenCalledWith("alert-1", null);
  });

  it("does not render images for episodes already announced or paused", async () => {
    const deps = dependencies({ openEpisodes: vi.fn(async () => [episode()]) });
    await checkTelemetryAlert(alert, {} as never, deps);
    await checkTelemetryAlert({ ...alert, notificationsPaused: true }, {} as never, deps);
    expect(deps.renderChart).not.toHaveBeenCalled();
  });
});
