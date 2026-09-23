import {
  beginAutomationRun,
  setAutomationRunStatus,
  type AutomationTriggerInput,
} from "../../../../packages/core/src/db/automations.js";
import {
  automationRunQueue,
  createJobBoss,
  prepareWorkerQueues,
} from "../../../../packages/core/src/jobs.js";

let boss: ReturnType<typeof createJobBoss> | undefined;
let bossStart: Promise<ReturnType<typeof createJobBoss>> | undefined;

async function getBoss() {
  if (boss) return boss;
  bossStart ??= (async () => {
    const nextBoss = createJobBoss();
    nextBoss.on("error", (error) => {
      console.error(
        JSON.stringify({
          errorCode: error instanceof Error ? error.constructor.name : "unknown",
          event: "automation_queue_error",
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

export async function queueAutomationRun(input: {
  automationId: string;
  trigger: AutomationTriggerInput;
}): Promise<{ duplicate: boolean; jobId?: string; runId: string }> {
  const run = await beginAutomationRun(input);
  if (!run.created) return { duplicate: true, runId: run.runId };

  try {
    const jobId = await (await getBoss()).send(
      automationRunQueue,
      {
        kind: "automation_run",
        queuedAt: new Date().toISOString(),
        runId: run.runId,
      },
      { singletonKey: input.automationId },
    );
    if (!jobId) throw new Error("Automation run job was not created");
    return { duplicate: false, jobId, runId: run.runId };
  } catch (error) {
    await setAutomationRunStatus({
      failureCategory: "queue_unavailable",
      failureMessage: "Automation worker is unavailable",
      runId: run.runId,
      status: "failed",
    });
    throw new Error("Automation worker is unavailable", { cause: error });
  }
}

export async function closeAutomationQueue(): Promise<void> {
  await boss?.stop({ graceful: true, timeout: 5_000 });
  boss = undefined;
  bossStart = undefined;
}
