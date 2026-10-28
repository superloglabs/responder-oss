import type { AutomationNotification } from "@responder/core/automations/config";
import {
  claimDueSyntheticChecks,
  continueSyntheticCheckEpisode,
  deleteSyntheticCheckRunsBefore,
  markSyntheticCheckRecoveryNotified,
  openSyntheticCheckEpisode,
  recordSyntheticRun,
  resolveSyntheticCheckEpisode,
  setSyntheticCheckEpisodeMessage,
  startSyntheticCheckEpisode,
  unannouncedSyntheticCheckRecoveries,
  type DueSyntheticCheck,
  type OpenSyntheticCheckEpisode,
} from "@responder/core/db/synthetic-checks";
import { responderSyntheticCheckUrl } from "@responder/core/responder-urls";
import { syntheticFailureReason } from "@responder/core/synthetics/assertions";
import { syntheticRunMetrics } from "@responder/core/synthetics/otlp";
import { runSyntheticCheck } from "@responder/core/synthetics/runner";
import { syntheticFailingMessage, syntheticRecoveredMessage } from "@responder/core/synthetics/text";
import type { SyntheticRunResult } from "@responder/core/synthetics/types";
import { telemetryCollectorUrl } from "@responder/core/telemetry/client";
import { postAutomationNotification } from "./automation-notifications.js";
import type { startAlertAutomations } from "./telemetry-alert-automations.js";

// Checks run at once by one worker. Each waits on the network, not the
// database, so many share the worker.
const concurrentChecks = 20;
// Runs are kept this long.
const runRetentionMs = 30 * 86_400_000;
const purgeBatch = 5_000;

export interface SyntheticCheckDependencies {
  claim: typeof claimDueSyntheticChecks;
  continueEpisode: typeof continueSyntheticCheckEpisode;
  // Sends a run's metrics to the workspace's telemetry. Null in a cell
  // without a collector.
  exportMetrics: ((organizationId: string, payload: unknown) => Promise<void>) | null;
  location: string;
  markRecoveryNotified: typeof markSyntheticCheckRecoveryNotified;
  now: () => Date;
  openEpisode: typeof openSyntheticCheckEpisode;
  origin: string | null;
  post: typeof postAutomationNotification;
  recordRun: typeof recordSyntheticRun;
  resolveEpisode: typeof resolveSyntheticCheckEpisode;
  run: (check: DueSyntheticCheck) => Promise<SyntheticRunResult>;
  setMessage: typeof setSyntheticCheckEpisodeMessage;
  startAutomations?: (input: Parameters<typeof startAlertAutomations>[0]) => Promise<number>;
  startEpisode: typeof startSyntheticCheckEpisode;
  unannouncedRecoveries: typeof unannouncedSyntheticCheckRecoveries;
}

// Where this worker's runs come from, such as its cloud region.
export function syntheticLocation(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.SYNTHETICS_LOCATION?.trim() || environment.AWS_REGION?.trim() || "local";
}

function collectorExport(collector: string | null) {
  if (!collector) return null;
  // The collector writes the workspace's ID onto every resource, as it does
  // for telemetry from the workspace's applications.
  return async (organizationId: string, payload: unknown) => {
    const response = await fetch(`${collector}/v1/metrics`, {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json", "x-superlog-project-id": organizationId },
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`The collector answered ${response.status}`);
  };
}

export const defaultSyntheticCheckDependencies: SyntheticCheckDependencies = {
  claim: claimDueSyntheticChecks,
  continueEpisode: continueSyntheticCheckEpisode,
  exportMetrics: collectorExport(telemetryCollectorUrl()),
  location: syntheticLocation(),
  markRecoveryNotified: markSyntheticCheckRecoveryNotified,
  now: () => new Date(),
  openEpisode: openSyntheticCheckEpisode,
  origin: process.env.RESPONDER_APP_URL ?? process.env.BETTER_AUTH_URL ?? null,
  post: postAutomationNotification,
  recordRun: recordSyntheticRun,
  resolveEpisode: resolveSyntheticCheckEpisode,
  run: (check) =>
    runSyntheticCheck(check, { allowLocal: process.env.NODE_ENV !== "production" }),
  setMessage: setSyntheticCheckEpisodeMessage,
  startEpisode: startSyntheticCheckEpisode,
  unannouncedRecoveries: unannouncedSyntheticCheckRecoveries,
};

function slackTarget(
  episode: Pick<OpenSyntheticCheckEpisode, "slackChannelId" | "slackIntegrationAccountId">,
): AutomationNotification | null {
  return episode.slackChannelId && episode.slackIntegrationAccountId
    ? { channelId: episode.slackChannelId, integrationAccountId: episode.slackIntegrationAccountId, kind: "slack" }
    : null;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function warn(event: string, checkId: string, error: unknown) {
  console.warn(JSON.stringify({ checkId, error: errorText(error), event }));
}

// Runs one claimed check, records the run, and opens, continues or ends its
// episode, posting to Slack as it does.
export async function processSyntheticCheck(
  check: DueSyntheticCheck,
  dependencies: SyntheticCheckDependencies,
): Promise<void> {
  const result = await dependencies.run(check);
  const failures = await dependencies.recordRun(check, result, dependencies.location);
  if (check.sendMetrics && dependencies.exportMetrics) {
    await dependencies
      .exportMetrics(check.organizationId, syntheticRunMetrics(check, result, dependencies.location))
      .catch((error: unknown) => warn("synthetic_check_metrics_failed", check.id, error));
  }
  // The check changed, was turned off, or was deleted while it ran.
  if (failures === null) return;

  const now = dependencies.now();
  const message = {
    checkName: check.name,
    checkUrl: dependencies.origin ? responderSyntheticCheckUrl(check.id, dependencies.origin) : null,
    method: check.method,
    url: check.url,
  };

  async function announce(episode: OpenSyntheticCheckEpisode, reason: string, failedRuns: number) {
    const target = slackTarget(episode);
    if (!target || episode.slackMessageTs) return;
    const content = syntheticFailingMessage({ ...message, failures: failedRuns, location: dependencies.location, reason });
    const [delivery] = await dependencies.post({
      ...content,
      handoff: { kind: "fix", sourceUrl: message.checkUrl },
      notifications: [target],
      organizationId: check.organizationId,
      seed: `synthetic-check-episode:${episode.id}:failing`,
    });
    if (delivery && "timestamp" in delivery && delivery.timestamp) {
      await dependencies.setMessage(episode.id, delivery.timestamp);
      await dependencies
        .startAutomations?.({
          body: content.markdown,
          channelId: target.channelId,
          episodeId: episode.id,
          episodeSource: "synthetic-check-episode",
          integrationAccountId: target.integrationAccountId,
          organizationId: check.organizationId,
          timestamp: delivery.timestamp,
          title: content.text,
        })
        .catch((error: unknown) => warn("synthetic_check_automations_failed", check.id, error));
    } else if (delivery) {
      // The next failed run tries again while the episode is open.
      warn("synthetic_check_post_failed", check.id, "error" in delivery ? delivery.error : "Slack did not return the message");
    }
  }

  async function announceRecovery(episode: OpenSyntheticCheckEpisode & { endedAt: Date }) {
    const target = slackTarget(episode);
    if (!target || !episode.slackMessageTs) {
      await dependencies.markRecoveryNotified(episode.id);
      return;
    }
    const content = syntheticRecoveredMessage({
      ...message,
      durationMs: result.durationMs,
      failingForMs: episode.endedAt.getTime() - episode.startedAt.getTime(),
      statusCode: result.response?.statusCode ?? null,
    });
    const [delivery] = await dependencies.post({
      ...content,
      handoff: { kind: "fix", sourceUrl: message.checkUrl },
      notifications: [target],
      organizationId: check.organizationId,
      seed: `synthetic-check-episode:${episode.id}:recovered`,
      threadTimestamp: episode.slackMessageTs,
    });
    if (delivery && "timestamp" in delivery) await dependencies.markRecoveryNotified(episode.id);
    else if (delivery) warn("synthetic_check_post_failed", check.id, delivery.error);
  }

  const episode = await dependencies.openEpisode(check.id);
  if (result.status === "failed") {
    const reason = syntheticFailureReason(result) ?? "The run failed";
    if (episode) {
      await dependencies.continueEpisode(episode.id);
      // An announcement that failed before is retried.
      await announce(episode, reason, episode.failedRuns + 1);
    } else if (failures >= check.failuresToAlert) {
      const opened = await dependencies.startEpisode({
        checkId: check.id,
        checkUpdatedAt: check.updatedAt,
        failedRuns: failures,
        reason,
        slack: check.slack,
      });
      if (opened) await announce(opened, reason, failures);
    }
    return;
  }
  if (episode && (await dependencies.resolveEpisode(episode.id))) {
    await announceRecovery({ ...episode, endedAt: now });
  }
  for (const recovery of await dependencies.unannouncedRecoveries(check.id)) {
    if (recovery.id !== episode?.id) await announceRecovery(recovery);
  }
}

// Claims due checks into free slots and runs them in the background, so a
// slow check does not hold up the others. A finished check frees its slot for
// the next due one at once.
export function createSyntheticCheckScheduler(
  dependencies: SyntheticCheckDependencies = defaultSyntheticCheckDependencies,
  options: { concurrency?: number; onError?: (error: unknown) => void } = {},
) {
  const concurrency = options.concurrency ?? concurrentChecks;
  const running = new Set<Promise<void>>();
  let claiming = false;
  let stopped = false;

  async function tick(): Promise<number> {
    if (claiming || stopped) return 0;
    claiming = true;
    try {
      const checks = await dependencies.claim(concurrency - running.size);
      for (const check of checks) {
        const task: Promise<void> = processSyntheticCheck(check, dependencies)
          .catch((error: unknown) => {
            warn("synthetic_check_failed", check.id, error);
            options.onError?.(error);
          })
          .finally(() => {
            running.delete(task);
            if (!stopped) void tick().catch((error: unknown) => options.onError?.(error));
          });
        running.add(task);
      }
      return checks.length;
    } finally {
      claiming = false;
    }
  }

  return {
    // Stops claiming and waits for the checks already running.
    async stop(): Promise<void> {
      stopped = true;
      await Promise.all([...running]);
    },
    tick,
  };
}

// Deletes runs past their retention, a batch at a time.
export async function purgeSyntheticCheckRuns(
  now: Date = new Date(),
  deleteBefore: typeof deleteSyntheticCheckRunsBefore = deleteSyntheticCheckRunsBefore,
): Promise<number> {
  const before = new Date(now.getTime() - runRetentionMs);
  let deleted = 0;
  for (let batch = 0; batch < 20; batch += 1) {
    const count = await deleteBefore(before, purgeBatch);
    deleted += count;
    if (count < purgeBatch) break;
  }
  return deleted;
}
