import type { AutomationNotification } from "@responder/core/automations/config";
import {
  claimDueTelemetryAlerts,
  continueTelemetryAlertEpisode,
  markTelemetryAlertRecoveryNotified,
  openTelemetryAlertEpisode,
  openTelemetryAlertEpisodes,
  recordTelemetryAlertCheck,
  resolveTelemetryAlertEpisode,
  setTelemetryAlertEpisodeMessage,
  unannouncedTelemetryAlertRecoveries,
  type DueTelemetryAlert,
  type OpenTelemetryAlertEpisode,
} from "@responder/core/db/telemetry-alerts";
import { responderAlertUrl } from "@responder/core/responder-urls";
import { alertValues } from "@responder/core/telemetry/alert-values";
import {
  alertFiringMessage,
  alertRecoveredMessage,
  alertTransition,
  evaluateAlert,
} from "@responder/core/telemetry/alerts";
import { getTelemetryClient, type TelemetryClient } from "@responder/core/telemetry/client";
import { postAutomationNotification } from "./automation-notifications.js";
import { alertImageLayout } from "./telemetry-alert-message.js";
import { renderAlertChart } from "./telemetry-alert-chart.js";
import type { startAlertAutomations } from "./telemetry-alert-automations.js";

// Alerts claimed per pass, and checked at once. The read-only store limits
// concurrent queries, and the API shares it.
const alertsPerPass = 20;
const concurrentChecks = 4;
// Episodes announced per alert check. A rule grouped by a busy attribute can
// open many at once; the rest are announced on later checks.
const announcementsPerCheck = 10;

export interface TelemetryAlertDependencies {
  claim: typeof claimDueTelemetryAlerts;
  client: () => TelemetryClient | null;
  continueEpisode: typeof continueTelemetryAlertEpisode;
  markRecoveryNotified: typeof markTelemetryAlertRecoveryNotified;
  now: () => Date;
  openEpisode: typeof openTelemetryAlertEpisode;
  openEpisodes: typeof openTelemetryAlertEpisodes;
  origin: string | null;
  post: typeof postAutomationNotification;
  recordCheck: typeof recordTelemetryAlertCheck;
  renderChart: typeof renderAlertChart;
  resolveEpisode: typeof resolveTelemetryAlertEpisode;
  setMessage: typeof setTelemetryAlertEpisodeMessage;
  // Starts the automations watching the alert's channel. The worker supplies
  // it with its job queue; without it, alerts only post.
  startAutomations?: (input: Parameters<typeof startAlertAutomations>[0]) => Promise<number>;
  unannouncedRecoveries: typeof unannouncedTelemetryAlertRecoveries;
  values: typeof alertValues;
}

export const defaultTelemetryAlertDependencies: TelemetryAlertDependencies = {
  claim: claimDueTelemetryAlerts,
  client: getTelemetryClient,
  continueEpisode: continueTelemetryAlertEpisode,
  markRecoveryNotified: markTelemetryAlertRecoveryNotified,
  now: () => new Date(),
  openEpisode: openTelemetryAlertEpisode,
  openEpisodes: openTelemetryAlertEpisodes,
  origin: process.env.RESPONDER_APP_URL ?? process.env.BETTER_AUTH_URL ?? null,
  post: postAutomationNotification,
  recordCheck: recordTelemetryAlertCheck,
  renderChart: renderAlertChart,
  resolveEpisode: resolveTelemetryAlertEpisode,
  setMessage: setTelemetryAlertEpisodeMessage,
  unannouncedRecoveries: unannouncedTelemetryAlertRecoveries,
  values: alertValues,
};

function slackTarget(episode: Pick<OpenTelemetryAlertEpisode, "slackChannelId" | "slackIntegrationAccountId">):
  AutomationNotification | null {
  return episode.slackChannelId && episode.slackIntegrationAccountId
    ? { channelId: episode.slackChannelId, integrationAccountId: episode.slackIntegrationAccountId, kind: "slack" }
    : null;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export async function checkTelemetryAlert(
  alert: DueTelemetryAlert,
  client: TelemetryClient,
  dependencies: TelemetryAlertDependencies,
): Promise<void> {
  const now = dependencies.now();
  const message = (groupKey: string, value: number) => ({
    alertName: alert.name,
    alertUrl: dependencies.origin ? responderAlertUrl(alert.id, dependencies.origin) : null,
    groupBy: alert.groupMode === "per_group" ? alert.groupBy : null,
    groupKey,
    rule: alert,
    value,
  });
  let announcements = 0;
  // The last failed Slack post, shown on the alert until a check posts fine.
  let postError: string | null = null;

  async function announce(episode: OpenTelemetryAlertEpisode, value: number) {
    const target = slackTarget(episode);
    // An episode opened while paused stays unannounced after the pause ends.
    if (!target || alert.notificationsPaused || episode.notificationsPaused) return;
    if (episode.slackMessageTs || announcements >= announcementsPerCheck) return;
    announcements += 1;
    const content = alertFiringMessage(message(episode.groupKey, value));
    const image = await dependencies.renderChart({ client, groupKey: episode.groupKey, now, organizationId: alert.organizationId, rule: alert }).catch((error: unknown) => {
      console.warn(JSON.stringify({ alertId: alert.id, error: errorText(error), event: "telemetry_alert_chart_failed" }));
      return undefined;
    });
    const [delivery] = await dependencies.post({
      ...content,
      image,
      imageLayout: alertImageLayout(message(episode.groupKey, value)),
      unfurlLinks: false,
      notifications: [target],
      organizationId: alert.organizationId,
      seed: `telemetry-alert-episode:${episode.id}:firing`,
    });
    if (delivery && "timestamp" in delivery && delivery.timestamp) {
      await dependencies.setMessage(episode.id, delivery.timestamp);
      if (dependencies.startAutomations) {
        await dependencies
          .startAutomations({
            body: content.markdown,
            channelId: target.channelId,
            episodeId: episode.id,
            integrationAccountId: target.integrationAccountId,
            organizationId: alert.organizationId,
            timestamp: delivery.timestamp,
            title: content.text,
          })
          .catch((error: unknown) => {
            console.warn(JSON.stringify({ alertId: alert.id, error: errorText(error), event: "telemetry_alert_automations_failed" }));
          });
      }
    } else if (delivery) {
      // The next check tries again while the episode is open. Without a
      // message ID there is no thread to reply in, so that is a failure too.
      postError = "error" in delivery ? errorText(delivery.error) : "Slack did not return the message";
      console.warn(JSON.stringify({ alertId: alert.id, error: postError, event: "telemetry_alert_post_failed" }));
    }
  }

  async function announceRecovery(
    episode: OpenTelemetryAlertEpisode & { endedAt: Date },
    value: number,
  ) {
    const target = slackTarget(episode);
    if (!target || !episode.slackMessageTs) {
      await dependencies.markRecoveryNotified(episode.id);
      return;
    }
    // Posted once the pause ends, if the recovery is still recent.
    if (alert.notificationsPaused) return;
    const content = alertRecoveredMessage({
      ...message(episode.groupKey, value),
      firingForMs: episode.endedAt.getTime() - episode.startedAt.getTime(),
    });
    const [delivery] = await dependencies.post({
      ...content,
      notifications: [target],
      organizationId: alert.organizationId,
      seed: `telemetry-alert-episode:${episode.id}:recovered`,
      threadTimestamp: episode.slackMessageTs,
    });
    if (delivery && "timestamp" in delivery) await dependencies.markRecoveryNotified(episode.id);
    else if (delivery) {
      postError = errorText(delivery.error);
      console.warn(JSON.stringify({ alertId: alert.id, error: postError, event: "telemetry_alert_post_failed" }));
    }
  }

  try {
    const rows = await dependencies.values(client, alert.organizationId, alert, now);
    const open = await dependencies.openEpisodes(alert.id);
    const openByGroup = new Map(open.map((episode) => [episode.groupKey, episode]));
    for (const evaluation of evaluateAlert(alert, rows, [...openByGroup.keys()])) {
      const episode = openByGroup.get(evaluation.groupKey);
      const transition = alertTransition(evaluation.breaching, Boolean(episode));
      if (transition === "opened") {
        const opened = await dependencies.openEpisode({
          alertId: alert.id,
          groupKey: evaluation.groupKey,
          ruleUpdatedAt: alert.updatedAt,
          slack: alert.slack,
          value: evaluation.value,
        });
        if (opened) await announce(opened, evaluation.value);
      } else if (transition === "continued" && episode) {
        await dependencies.continueEpisode(episode, alert.comparator, evaluation.value);
        // An announcement that failed before is retried.
        await announce(episode, evaluation.value);
      } else if (transition === "recovered" && episode) {
        if (await dependencies.resolveEpisode(episode.id, evaluation.value)) {
          await announceRecovery({ ...episode, endedAt: now }, evaluation.value);
        }
      }
    }
    for (const recovery of await dependencies.unannouncedRecoveries(alert.id)) {
      if (recovery.endedAt.getTime() < now.getTime()) await announceRecovery(recovery, recovery.lastValue);
    }
    await dependencies.recordCheck(alert.id, postError ? `Posting to Slack failed: ${postError}` : null);
  } catch (error) {
    console.warn(JSON.stringify({ alertId: alert.id, error: errorText(error), event: "telemetry_alert_check_failed" }));
    await dependencies.recordCheck(alert.id, errorText(error)).catch(() => undefined);
  }
}

// Checks the alerts that are due, a few at a time. Does nothing in a cell
// without a telemetry store.
export async function checkDueTelemetryAlerts(
  dependencies: TelemetryAlertDependencies = defaultTelemetryAlertDependencies,
): Promise<number> {
  const client = dependencies.client();
  if (!client) return 0;
  const alerts = await dependencies.claim(alertsPerPass);
  let next = 0;
  const worker = async () => {
    while (next < alerts.length) {
      const alert = alerts[next]!;
      next += 1;
      await checkTelemetryAlert(alert, client, dependencies);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrentChecks, alerts.length) }, worker));
  return alerts.length;
}
