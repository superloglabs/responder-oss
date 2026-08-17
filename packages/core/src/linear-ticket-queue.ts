import type { LinearTicketJob } from "./jobs.js";
import { linearTicketQueue } from "./jobs.js";
import { getRuntimeAgentConfig } from "./db/investigations.js";
import { listLinearTicketRequestsForQueue } from "./db/linear-tickets.js";

export interface LinearTicketJobQueue {
  send(
    name: string,
    data: LinearTicketJob,
    options: { singletonKey: string },
  ): Promise<string | null>;
}

export async function queuePendingLinearTicketJobs(
  queue: LinearTicketJobQueue,
): Promise<number> {
  const requests = await listLinearTicketRequestsForQueue();
  let queued = 0;
  for (const request of requests) {
    const config = await getRuntimeAgentConfig(request.agentConfigVersionId);
    if (!config) continue;
    try {
      await queueLinearTicketJob(queue, {
        config,
        investigationId: request.investigationId,
        requestId: request.requestId,
      });
      queued += 1;
    } catch (error) {
      if (!(error instanceof Error) ||
          error.message !== "The Linear ticket job was not created") {
        throw error;
      }
    }
  }
  return queued;
}

export async function queueLinearTicketJob(
  queue: LinearTicketJobQueue,
  input: Omit<LinearTicketJob, "kind" | "queuedAt">,
) {
  const jobId = await queue.send(
    linearTicketQueue,
    { ...input, kind: "linear_ticket", queuedAt: new Date().toISOString() },
    { singletonKey: `linear-ticket:${input.requestId}` },
  );
  if (!jobId) throw new Error("The Linear ticket job was not created");
  return { jobId, requestId: input.requestId };
}
