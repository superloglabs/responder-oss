import {
  consumeInvestigation,
  finalizeInvestigationReservation,
  reserveInvestigation,
} from "../../../../packages/core/src/billing/autumn.js";
import { notifyBillingLimitReached } from "../../../../packages/core/src/billing/notifications.js";
import { captureAnalyticsEvent } from "../../../../packages/core/src/analytics.js";
import {
  beginInvestigation,
  beginSlackThreadInvestigation,
  discardPendingInvestigation,
  failInvestigation,
  prepareInvestigationRetry,
} from "../../../../packages/core/src/db/investigations.js";
import { queueIssueRemediationJob } from "../../../../packages/core/src/remediation-queue.js";
import { queuePullRequestReviewJob } from "../../../../packages/core/src/pull-request-review-queue.js";
import {
  type InvestigationRequest,
  toInvestigationInput,
} from "../../../../packages/core/src/investigations/input.js";
import {
  createJobBoss,
  investigationQueue,
  prepareWorkerQueues,
  slackThreadInvestigationQueue,
} from "../../../../packages/core/src/jobs.js";

type QueueResult =
  | { kind: "blocked" }
  | { investigationId: string; kind: "duplicate" }
  | { investigationId: string; jobId: string; kind: "queued" };

type RetryQueueResult =
  | { kind: "blocked" }
  | { investigationId: string; jobId: string; kind: "queued" };

let boss: ReturnType<typeof createJobBoss> | undefined;
let bossStart: Promise<ReturnType<typeof createJobBoss>> | undefined;

async function getBoss() {
  if (boss) return boss;
  bossStart ??= (async () => {
    const nextBoss = createJobBoss();
    nextBoss.on("error", (error) => {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          event: "api_job_queue_error",
        }),
      );
    });
    await nextBoss.start();
    await prepareWorkerQueues(nextBoss);
    boss = nextBoss;
    return nextBoss;
  })().catch((error: unknown) => {
    bossStart = undefined;
    throw error;
  });
  return bossStart;
}

export async function queueInvestigation(
  request: InvestigationRequest,
): Promise<QueueResult> {
  const input = toInvestigationInput(request);
  const result = await beginInvestigation(request.agentId, input);
  if (!result.created) {
    return { investigationId: result.investigationId, kind: "duplicate" };
  }

  try {
    const access = await consumeInvestigation(
      result.config.organizationId,
      result.investigationId,
    );
    if (!access.allowed) {
      await discardPendingInvestigation(result.investigationId);
      await notifyBillingLimitReached(
        result.config.organizationId,
        access.nextResetAt,
      ).catch((error: unknown) => {
        console.error("Unable to send billing limit notifications", error);
      });
      return { kind: "blocked" };
    }
  } catch (error) {
    await discardPendingInvestigation(result.investigationId);
    console.error("Unable to meter investigation", error);
    throw new Error("Billing service unavailable", { cause: error });
  }

  await captureAnalyticsEvent({
    distinctId: `investigation:${result.investigationId}`,
    event: "investigation created",
    organizationId: result.config.organizationId,
    properties: {
      $process_person_profile: false,
      agent_config_version_id: result.config.id,
      agent_id: result.config.agentId,
      investigation_id: result.investigationId,
      is_replay: false,
      provider: input.provider,
    },
  });

  try {
    const jobId = await (await getBoss()).send(
      investigationQueue,
      {
        kind: "investigation",
        config: {
          agentId: result.config.agentId,
          id: result.config.id,
          model: result.config.model,
          organizationId: result.config.organizationId,
          prMode: result.config.prMode,
          prompt: result.config.prompt,
        },
        investigationId: result.investigationId,
        queuedAt: new Date().toISOString(),
        request,
        runtimeProfileId: result.runtimeProfileId,
      },
      { singletonKey: result.investigationId },
    );
    if (!jobId) throw new Error("The investigation job was not created");
    return { investigationId: result.investigationId, jobId, kind: "queued" };
  } catch (error) {
    await failInvestigation(
      result.investigationId,
      error instanceof Error ? error.message : "Unable to queue investigation",
    );
    throw new Error("Investigation worker is unavailable", { cause: error });
  }
}

export async function queueSlackThreadInvestigation(
  request: InvestigationRequest,
  thread: { teamId: string; channelId: string; threadTimestamp: string },
): Promise<QueueResult> {
  const input = toInvestigationInput(request);
  const result = await beginSlackThreadInvestigation({
    agentId: request.agentId,
    investigationInput: input,
    ...thread,
  });
  if (!result.created) {
    return { investigationId: result.investigationId, kind: "duplicate" };
  }

  try {
    const access = await consumeInvestigation(
      result.config.organizationId,
      result.investigationId,
    );
    if (!access.allowed) {
      await discardPendingInvestigation(result.investigationId);
      await notifyBillingLimitReached(
        result.config.organizationId,
        access.nextResetAt,
      ).catch(() => undefined);
      return { kind: "blocked" };
    }
  } catch (error) {
    await discardPendingInvestigation(result.investigationId);
    throw new Error("Billing service unavailable", { cause: error });
  }

  await captureAnalyticsEvent({
    distinctId: `investigation:${result.investigationId}`,
    event: "investigation created",
    organizationId: result.config.organizationId,
    properties: {
      $process_person_profile: false,
      agent_config_version_id: result.config.id,
      agent_id: result.config.agentId,
      investigation_id: result.investigationId,
      is_replay: false,
      provider: "slack",
      slack_thread_mode: true,
    },
  });

  try {
    const jobId = await (await getBoss()).send(
      slackThreadInvestigationQueue,
      {
        kind: "slack_thread_investigation",
        config: {
          agentId: result.config.agentId,
          id: result.config.id,
          model: result.config.model,
          organizationId: result.config.organizationId,
          prMode: "disabled",
          prompt: result.config.prompt,
        },
        investigationId: result.investigationId,
        queuedAt: new Date().toISOString(),
        refreshWorkspace: result.configurationChanged,
        request,
        runtimeProfileId: result.runtimeProfileId,
        slackInvestigationSessionId: result.slackInvestigationSessionId,
      },
      { singletonKey: result.slackInvestigationSessionId },
    );
    if (!jobId) throw new Error("The Slack investigation turn was not created");
    return { investigationId: result.investigationId, jobId, kind: "queued" };
  } catch (error) {
    await failInvestigation(
      result.investigationId,
      error instanceof Error ? error.message : "Unable to queue investigation",
    );
    throw new Error("Investigation worker is unavailable", { cause: error });
  }
}

export async function queueInvestigationRetry(input: {
  investigationId: string;
  organizationId: string;
}): Promise<RetryQueueResult> {
  let reservation: Awaited<ReturnType<typeof reserveInvestigation>>;
  try {
    reservation = await reserveInvestigation(
      input.organizationId,
      input.investigationId,
    );
    if (!reservation.allowed) {
      await notifyBillingLimitReached(
        input.organizationId,
        reservation.nextResetAt,
      ).catch((error: unknown) => {
        console.error("Unable to send billing limit notifications", error);
      });
      return { kind: "blocked" };
    }
  } catch (error) {
    console.error("Unable to reserve investigation rerun", error);
    throw new Error("Billing service unavailable", { cause: error });
  }

  let result: Awaited<ReturnType<typeof prepareInvestigationRetry>>;
  try {
    result = await prepareInvestigationRetry(input.investigationId);
  } catch (error) {
    if (reservation.reservationId) {
      await finalizeInvestigationReservation(
        reservation.reservationId,
        "release",
      ).catch((releaseError: unknown) => {
        // The provider automatically releases this reservation at expiry.
        console.error("Unable to release investigation rerun", releaseError);
      });
    }
    throw error;
  }

  if (reservation.reservationId) {
    try {
      await finalizeInvestigationReservation(
        reservation.reservationId,
        "confirm",
      );
    } catch (error) {
      await finalizeInvestigationReservation(
        reservation.reservationId,
        "release",
      ).catch((releaseError: unknown) => {
        // The provider automatically releases this reservation at expiry.
        console.error("Unable to release investigation rerun", releaseError);
      });
      await failInvestigation(
        result.investigationId,
        "Unable to confirm investigation rerun billing",
      );
      console.error("Unable to meter investigation rerun", error);
      throw new Error("Billing service unavailable", { cause: error });
    }
  }

  await captureAnalyticsEvent({
    distinctId: `investigation:${result.investigationId}`,
    event: "investigation rerun",
    organizationId: result.config.organizationId,
    properties: {
      $process_person_profile: false,
      agent_config_version_id: result.config.id,
      agent_id: result.config.agentId,
      investigation_id: result.investigationId,
      provider: result.input.provider,
    },
  });
  try {
    const jobId = await (await getBoss()).send(
      investigationQueue,
      {
        kind: "investigation",
        config: result.config,
        investigationId: result.investigationId,
        queuedAt: new Date().toISOString(),
        request: {
          agentId: result.config.agentId,
          body: result.input.body,
          externalEventId: result.input.externalEventId,
          provider: result.input.provider,
          title: result.input.title,
          ...(result.input.sourceUrl
            ? { sourceUrl: result.input.sourceUrl }
            : {}),
          ...(result.input.attributes
            ? { attributes: result.input.attributes }
            : {}),
        },
        runtimeProfileId: result.runtimeProfileId,
      },
      { singletonKey: `retry:${result.investigationId}:${Date.now()}` },
    );
    if (!jobId) throw new Error("The investigation retry job was not created");
    return {
      investigationId: result.investigationId,
      jobId,
      kind: "queued",
    };
  } catch (error) {
    await failInvestigation(
      result.investigationId,
      error instanceof Error ? error.message : "Unable to queue retry",
    );
    throw error;
  }
}

export async function queueIssueRemediation(requestId: string) {
  return queueIssueRemediationJob(
    {
      send: async (name, data, options) =>
        (await getBoss()).send(name, data, options),
    },
    requestId,
  );
}

export async function queuePullRequestReview(input: {
  installationId: number;
  pullRequestNumber: number;
  reviewComment: {
    author: string;
    body: string;
    id: number;
    line: number | null;
    path: string;
    url: string;
  };
  repositoryFullName: string;
}) {
  return queuePullRequestReviewJob(
    {
      send: async (name, data, options) =>
        (await getBoss()).send(name, data, options),
    },
    input,
  );
}

export async function closeInvestigationQueue(): Promise<void> {
  const currentBoss = boss;
  boss = undefined;
  bossStart = undefined;
  if (currentBoss) {
    await currentBoss.stop({ graceful: true, timeout: 10_000 });
  }
}
