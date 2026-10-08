import {
  abandonPendingAutomationRun,
  addAutomationRunReply,
  beginAutomationRun,
  continueAutomationRun,
  reopenAutomationRun,
  setAutomationRunStatus,
  type AutomationTriggerInput,
} from "../../../../packages/core/src/db/automations.js";
import type { AutomationUserMessageEventData } from "../../../../packages/core/src/automations/transcript.js";
import {
  automationRunJobOptions,
  automationRunQueue,
  createJobBoss,
  prepareWorkerQueues,
} from "../../../../packages/core/src/jobs.js";

let boss: ReturnType<typeof createJobBoss> | undefined;
let bossStart: Promise<ReturnType<typeof createJobBoss>> | undefined;
let queueGeneration = 0;

async function getBoss() {
  if (boss) return boss;
  if (!bossStart) {
    const generation = queueGeneration;
    bossStart = (async () => {
      const nextBoss = createJobBoss();
      nextBoss.on("error", (error) => {
        console.error(
          JSON.stringify({
            errorCode: error instanceof Error ? error.constructor.name : "unknown",
            event: "automation_queue_error",
          }),
        );
      });
      try {
        await nextBoss.start();
        await prepareWorkerQueues(nextBoss);
        if (generation !== queueGeneration) {
          await nextBoss.stop({ graceful: true, timeout: 5_000 });
          throw new Error("Automation queue closed during startup");
        }
        boss = nextBoss;
        return nextBoss;
      } catch (error) {
        await nextBoss.stop({ graceful: true, timeout: 5_000 }).catch(() => undefined);
        throw error;
      }
    })();
  }
  const start = bossStart;
  try {
    return await start;
  } finally {
    if (bossStart === start) bossStart = undefined;
  }
}

async function sendAutomationRunJob(run: {
  organizationId: string;
  runId: string;
}): Promise<string> {
  const jobId = await (await getBoss()).send(automationRunQueue, {
    kind: "automation_run",
    queuedAt: new Date().toISOString(),
    runId: run.runId,
  }, automationRunJobOptions(run.organizationId));
  if (!jobId) throw new Error("Automation run job was not created");
  return jobId;
}

export async function queueAutomationRun(input: {
  automationId: string;
  message?: AutomationUserMessageEventData;
  trigger: AutomationTriggerInput;
}): Promise<{ duplicate: boolean; jobId?: string; runId: string }> {
  const run = await beginAutomationRun(input);
  if (!run.created) return { duplicate: true, runId: run.runId };

  try {
    const jobId = await sendAutomationRunJob(run);
    return { duplicate: false, jobId, runId: run.runId };
  } catch (error) {
    await abandonPendingAutomationRun(run.runId);
    throw new Error("Automation worker is unavailable", { cause: error });
  }
}

// Queues the next turn of a finished run. Returns null when the run cannot
// take a follow-up.
export async function queueAutomationRunFollowUp(input: {
  message: AutomationUserMessageEventData;
  organizationId: string;
  runId: string;
}): Promise<{ jobId: string } | null> {
  const run = await continueAutomationRun(input);
  if (!run) return null;
  try {
    return { jobId: await sendAutomationRunJob(input) };
  } catch (error) {
    await setAutomationRunStatus({
      failureCategory: "queue_unavailable",
      failureMessage: "The follow-up could not be queued. Try sending it again.",
      runId: input.runId,
      status: "failed",
    });
    throw new Error("Automation worker is unavailable", { cause: error });
  }
}

// Sends a reply from the run's Slack thread to the run. A finished run starts
// its next turn now; an active run answers it in the turn after this one.
export async function queueAutomationRunReply(input: {
  message: AutomationUserMessageEventData & { externalEventId: string };
  runId: string;
}): Promise<"duplicate" | "queued" | "waiting"> {
  if (!(await addAutomationRunReply(input))) return "duplicate";
  const organizationId = await reopenAutomationRun(input.runId);
  if (!organizationId) return "waiting";
  try {
    await sendAutomationRunJob({ organizationId, runId: input.runId });
    return "queued";
  } catch (error) {
    await setAutomationRunStatus({
      failureCategory: "queue_unavailable",
      failureMessage: "The Slack reply could not be queued. Reply again to retry.",
      runId: input.runId,
      status: "failed",
    });
    throw new Error("Automation worker is unavailable", { cause: error });
  }
}

export async function closeAutomationQueue(): Promise<void> {
  queueGeneration += 1;
  const activeBoss = boss;
  const startingBoss = bossStart;
  boss = undefined;
  bossStart = undefined;
  const startedBoss = await startingBoss?.catch(() => undefined);
  const bosses = new Set([activeBoss, startedBoss].filter(Boolean));
  const shutdowns = await Promise.allSettled(
    [...bosses].map((nextBoss) =>
      nextBoss!.stop({ graceful: true, timeout: 5_000 })
    ),
  );
  const failures = shutdowns.flatMap((shutdown) =>
    shutdown.status === "rejected" ? [shutdown.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Unable to close the automation queue");
  }
}
