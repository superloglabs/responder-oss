import {
  createJobBoss,
  investigationQueue,
  linearTicketJobSchema,
  linearTicketQueue,
  prepareWorkerQueues,
  type LinearTicketJob,
  type RemediationJob,
  responderJobSchema,
  workerHealthJobSchema,
  workerHealthQueue,
} from "@responder/core/jobs";
import {
  appendInvestigationTraceEvent,
  failInvestigation,
  failInvestigationReplayRequest,
  markInvestigationStarted,
} from "@responder/core/db/investigations";
import {
  failIssuePullRequest,
  failPendingInvestigationPullRequests,
} from "@responder/core/db/pull-requests";
import { queueIssueRemediationJob } from "@responder/core/remediation-queue";
import {
  queueLinearTicketJob,
  queuePendingLinearTicketJobs,
} from "@responder/core/linear-ticket-queue";
import {
  failInvestigationSlackCard,
  updateInvestigationSlackProgress,
} from "@responder/core/integrations/slack-live-card";
import {
  applySlackTraceUpdate,
  slackProgressFromTrace,
  type SlackInvestigationTraceItem,
} from "@responder/core/integrations/slack-live-progress";
import {
  completeInvestigationRun,
  deliverPersistedInvestigationAfterFailure,
} from "./investigation-completion.js";
import {
  runInvestigationAgent,
  safeInvestigationError,
} from "./investigate.js";
import {
  remediationRunDiagnostics,
  runRemediationAgent,
} from "./remediate.js";
import { runLinearTicketJob } from "./linear-ticket-job.js";
import {
  InvestigationReplayRequestProcessingError,
  processNextInvestigationReplayRequest,
} from "./replay-requests.js";
import {
  flushWorkerMonitoring,
  initializeErrorMonitoring,
  reportWorkerException,
} from "./monitoring.js";

const secretsFile = process.env.RESPONDER_SECRETS_FILE;
if (secretsFile) process.loadEnvFile(secretsFile);
initializeErrorMonitoring();

const boss = createJobBoss();
const remediationQueue = {
  send: (
    name: string,
    data: RemediationJob,
    options: { singletonKey: string },
  ) => boss.send(name, data, options),
};
const linearTicketJobQueue = {
  send: (
    name: string,
    data: LinearTicketJob,
    options: { singletonKey: string },
  ) => boss.send(name, data, options),
};
let stopping = false;
let replayRequestDrain: Promise<void> | undefined;
let linearTicketDrain: Promise<void> | undefined;

const replayRequestQueue = {
  send: (
    name: string,
    data: Record<string, unknown>,
    options: { singletonKey: string },
  ) => boss.send(name, data, options),
};

function drainInvestigationReplayRequests(): Promise<void> {
  if (replayRequestDrain) return replayRequestDrain;
  replayRequestDrain = (async () => {
    while (
      !stopping &&
      (await processNextInvestigationReplayRequest(replayRequestQueue))
    ) {
      // Drain every currently available request before returning to polling.
    }
  })()
    .catch(async (error: unknown) => {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          event: "investigation_replay_request_failed",
          ...(error instanceof InvestigationReplayRequestProcessingError
            ? {
                investigationId: error.investigationId,
                sourceInvestigationId: error.sourceInvestigationId,
              }
            : {}),
        }),
      );
      await reportWorkerException(error, {
        operation: "worker",
        ...(error instanceof InvestigationReplayRequestProcessingError
          ? {
              investigationId: error.investigationId,
              sourceInvestigationId: error.sourceInvestigationId,
            }
          : {}),
      }).catch(
        (reportError: unknown) => {
          console.error(
            JSON.stringify({
              error:
                reportError instanceof Error
                  ? reportError.message
                  : String(reportError),
              event: "replay_drain_error_reporting_failed",
              ...(error instanceof InvestigationReplayRequestProcessingError
                ? {
                    investigationId: error.investigationId,
                    sourceInvestigationId: error.sourceInvestigationId,
                  }
                : {}),
            }),
          );
        },
      );
    })
    .finally(() => {
      replayRequestDrain = undefined;
    });
  return replayRequestDrain;
}

function drainLinearTicketRequests(): Promise<void> {
  if (linearTicketDrain) return linearTicketDrain;
  linearTicketDrain = queuePendingLinearTicketJobs(linearTicketJobQueue)
    .then(() => undefined)
    .catch((error: unknown) => {
      console.error(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        event: "linear_ticket_queue_drain_failed",
      }));
      return reportWorkerException(error, { operation: "linear_ticket" });
    })
    .finally(() => {
      linearTicketDrain = undefined;
    });
  return linearTicketDrain;
}

async function reportIncompleteSlackDelivery(input: {
  deliveryWarnings: string[];
  investigationId: string;
  jobId: string;
  organizationId: string;
}): Promise<void> {
  if (input.deliveryWarnings.length === 0) return;
  console.error(
    JSON.stringify({
      deliveryWarnings: input.deliveryWarnings,
      event: "investigation_slack_delivery_incomplete",
      investigationId: input.investigationId,
    }),
  );
  await reportWorkerException(
    new AggregateError(
      input.deliveryWarnings.map((warning) => new Error(warning)),
      "Slack investigation delivery incomplete",
    ),
    {
      investigationId: input.investigationId,
      jobId: input.jobId,
      operation: "slack_delivery",
      organizationId: input.organizationId,
    },
  );
}

boss.on("error", (error) => {
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      event: "worker_error",
    }),
  );
  void reportWorkerException(error, { operation: "worker" });
});

await boss.start();
await prepareWorkerQueues(boss);
await boss.work(workerHealthQueue, { localConcurrency: 1 }, async ([job]) => {
  const payload = workerHealthJobSchema.parse(job.data);
  const processedAt = new Date().toISOString();

  console.log(
    JSON.stringify({
      event: "worker_health_job_complete",
      jobId: job.id,
      marker: payload.marker,
      processedAt,
      requestedAt: payload.requestedAt,
    }),
  );

  return { marker: payload.marker, processedAt };
});
await boss.work(linearTicketQueue, { localConcurrency: 2 }, async ([job]) => {
  const payload = linearTicketJobSchema.parse(job.data);
  try {
    await runLinearTicketJob(payload, process.env);
    console.log(JSON.stringify({
      event: "linear_ticket_job_complete",
      jobId: job.id,
      requestId: payload.requestId,
    }));
    return { requestId: payload.requestId };
  } catch (error) {
    await reportWorkerException(error, {
      investigationId: payload.investigationId,
      jobId: job.id,
      operation: "linear_ticket",
      organizationId: payload.config.organizationId,
      requestId: payload.requestId,
    });
    throw error;
  }
});
await boss.work(investigationQueue, { localConcurrency: 1 }, async ([job]) => {
  const payload = responderJobSchema.parse(job.data);
  if (payload.kind === "remediation") {
    try {
      await runRemediationAgent(payload, process.env);
      await failIssuePullRequest(
        payload.remediationRequestId,
        "Remediation finished without creating a pull request",
      );
      console.log(
        JSON.stringify({
          event: "remediation_job_complete",
          jobId: job.id,
          requestId: payload.remediationRequestId,
        }),
      );
    } catch (error) {
      const message = safeInvestigationError(error);
      let diagnostics: ReturnType<typeof remediationRunDiagnostics>;
      try {
        diagnostics = remediationRunDiagnostics(error, process.env);
      } catch {
        diagnostics = undefined;
      }
      await reportWorkerException(error, {
        ...(diagnostics ? { diagnostics: { ...diagnostics } } : {}),
        investigationId: payload.investigationId,
        jobId: job.id,
        operation: "remediation",
        organizationId: payload.config.organizationId,
        requestId: payload.remediationRequestId,
      });
      await failIssuePullRequest(payload.remediationRequestId, message);
      console.error(
        JSON.stringify({
          ...(diagnostics ? { diagnostics } : {}),
          error: message,
          event: "remediation_job_failed",
          jobId: job.id,
          requestId: payload.remediationRequestId,
        }),
      );
    }
    return { requestId: payload.remediationRequestId };
  }
  await markInvestigationStarted(
    payload.investigationId,
    `openai-daytona:${job.id}`,
  );

  let finalizingSlackCard = false;
  let lastSlackProgressAt = 0;
  let slackProgressFailureReported = false;
  let slackTraceItems: SlackInvestigationTraceItem[] = [];

  try {
    const report = await runInvestigationAgent(
      payload,
      process.env,
      async (event) => {
        await appendInvestigationTraceEvent(payload.investigationId, event);
        if (payload.replay || finalizingSlackCard) return;
        const progress = slackProgressFromTrace(event);
        if (!progress) return;
        slackTraceItems = applySlackTraceUpdate(slackTraceItems, progress);
        const now = Date.now();
        if (!progress.finalizing && now - lastSlackProgressAt < 3_000) return;
        lastSlackProgressAt = now;
        await updateInvestigationSlackProgress(
          payload.investigationId,
          progress.detail,
          slackTraceItems,
        ).catch(async (error: unknown) => {
          if (slackProgressFailureReported) return;
          slackProgressFailureReported = true;
          await reportWorkerException(error, {
            investigationId: payload.investigationId,
            jobId: job.id,
            operation: "slack_delivery",
            organizationId: payload.config.organizationId,
          });
        });
        if (progress.finalizing) finalizingSlackCard = true;
      },
      { jobId: job.id },
      async (requestIds) => {
        const queued = await Promise.allSettled(
          requestIds.map(async (requestId) => {
            const result = await queueIssueRemediationJob(
              remediationQueue,
              requestId,
            );
            console.log(
              JSON.stringify({
                event: "automatic_remediation_queued",
                investigationId: payload.investigationId,
                jobId: result.jobId,
                requestId: result.requestId,
              }),
            );
            return result;
          }),
        );
        await Promise.all(
          queued.map(async (result, index) => {
            if (result.status === "fulfilled") return;
            const requestId = requestIds[index]!;
            const error = result.reason;
            console.error(
              JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
                event: "automatic_remediation_queue_failed",
                investigationId: payload.investigationId,
                requestId,
              }),
            );
            await reportWorkerException(error, {
              investigationId: payload.investigationId,
              operation: "remediation",
              organizationId: payload.config.organizationId,
              requestId,
            });
          }),
        );
      },
      async (requestIds) => {
        await Promise.all(requestIds.map(async (requestId) => {
          const result = await queueLinearTicketJob(linearTicketJobQueue, {
            config: payload.config,
            investigationId: payload.investigationId,
            requestId,
          });
          console.log(JSON.stringify({
            event: "linear_ticket_queued",
            investigationId: payload.investigationId,
            jobId: result.jobId,
            requestId,
          }));
        }));
      },
    );
    const deliveryWarnings = await completeInvestigationRun({
      investigationId: payload.investigationId,
      replay: payload.replay,
      report,
    });
    await reportIncompleteSlackDelivery({
      deliveryWarnings,
      investigationId: payload.investigationId,
      jobId: job.id,
      organizationId: payload.config.organizationId,
    });
    console.log(
      JSON.stringify({
        event: "investigation_job_complete",
        investigationId: payload.investigationId,
        jobId: job.id,
      }),
    );
    return { investigationId: payload.investigationId };
  } catch (error) {
    const message = safeInvestigationError(error);
    await reportWorkerException(error, {
      investigationId: payload.investigationId,
      jobId: job.id,
      operation: "investigation",
      organizationId: payload.config.organizationId,
    });
    const investigationFailed = await failInvestigation(
      payload.investigationId,
      message,
    );
    await failInvestigationReplayRequest(payload.investigationId, message);
    await failPendingInvestigationPullRequests(
      payload.investigationId,
      "Investigation failed before remediation could be queued",
    );
    const deliveryWarnings = await deliverPersistedInvestigationAfterFailure({
      investigationFailed,
      investigationId: payload.investigationId,
      replay: payload.replay,
    });
    await reportIncompleteSlackDelivery({
      deliveryWarnings,
      investigationId: payload.investigationId,
      jobId: job.id,
      organizationId: payload.config.organizationId,
    });
    if (!payload.replay && investigationFailed) {
      await failInvestigationSlackCard(
        payload.investigationId,
        slackTraceItems.length > 0 ? slackTraceItems : undefined,
      ).catch(() => undefined);
    }
    console.error(
      JSON.stringify({
        error: message,
        event: "investigation_job_failed",
        investigationId: payload.investigationId,
        jobId: job.id,
      }),
    );
    throw new Error(message, { cause: error });
  }
});

void drainInvestigationReplayRequests();
void drainLinearTicketRequests();
const replayRequestPoller = setInterval(
  () => void drainInvestigationReplayRequests(),
  2_000,
);
replayRequestPoller.unref();
const linearTicketPoller = setInterval(
  () => void drainLinearTicketRequests(),
  10_000,
);
linearTicketPoller.unref();

console.log(JSON.stringify({ event: "worker_ready" }));

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(replayRequestPoller);
  clearInterval(linearTicketPoller);
  await replayRequestDrain;
  await linearTicketDrain;
  console.log(JSON.stringify({ event: "worker_stopping", signal }));
  try {
    await boss.stop({ graceful: true, timeout: 25_000 });
  } finally {
    await flushWorkerMonitoring();
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            event: "worker_shutdown_failed",
          }),
        );
        process.exit(1);
      });
  });
}
