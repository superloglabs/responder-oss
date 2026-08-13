import { consumeInvestigation } from "../../../../packages/core/src/billing/autumn.js";
import { notifyBillingLimitReached } from "../../../../packages/core/src/billing/notifications.js";
import {
  beginInvestigation,
  discardPendingInvestigation,
  failInvestigation,
  prepareInvestigationRetry,
} from "../../../../packages/core/src/db/investigations.js";
import { queueIssueRemediationJob } from "../../../../packages/core/src/remediation-queue.js";
import {
  type InvestigationRequest,
  toInvestigationInput,
} from "../../../../packages/core/src/investigations/input.js";
import {
  createJobBoss,
  investigationQueue,
  prepareWorkerQueues,
} from "../../../../packages/core/src/jobs.js";

type QueueResult =
  | { kind: "blocked" }
  | { investigationId: string; kind: "duplicate" }
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

export async function queueInvestigationRetry(investigationId: string) {
  const result = await prepareInvestigationRetry(investigationId);
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
    return { investigationId: result.investigationId, jobId };
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

export async function closeInvestigationQueue(): Promise<void> {
  const currentBoss = boss;
  boss = undefined;
  bossStart = undefined;
  if (currentBoss) {
    await currentBoss.stop({ graceful: true, timeout: 10_000 });
  }
}
