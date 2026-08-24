import { getRuntimeAgentConfig } from "./db/investigations.js";
import {
  claimIssuePullRequestForRemediation,
  failIssuePullRequest,
  getIssuePullRequestForRemediation,
  listStaleCreatingIssuePullRequests,
  recoverAbandonedIssuePullRequest,
  setIssuePullRequestSession,
} from "./db/pull-requests.js";
import {
  investigationQueue,
  remediationQueue,
  type RemediationJob,
} from "./jobs.js";

const abandonedRemediationRequestAgeMs = 2 * 60 * 60 * 1_000;
const terminalRemediationJobStates = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export interface RemediationJobQueue {
  send(
    name: string,
    data: RemediationJob,
    options: { singletonKey: string },
  ): Promise<string | null>;
}

export interface RemediationRecoveryQueue {
  findJobs(
    name: string,
    options: { key: string },
  ): Promise<Array<{ state: string }>>;
}

export async function recoverAbandonedIssueRemediations(
  queue: RemediationRecoveryQueue,
  now = new Date(),
): Promise<string[]> {
  // The cutoff is twice the queue's one-hour execution limit. Queue state is
  // still checked so a delayed but valid job is never mistaken for abandoned.
  const staleBefore = new Date(
    now.getTime() - abandonedRemediationRequestAgeMs,
  );
  const candidates = await listStaleCreatingIssuePullRequests(staleBefore);
  const recovered: string[] = [];

  for (const candidate of candidates) {
    const key = `remediation:${candidate.requestId}`;
    const jobs = (
      await Promise.all([
        queue.findJobs(remediationQueue, { key }),
        // Workers still drain remediation jobs accepted by the former shared
        // investigation queue during a rolling deployment.
        queue.findJobs(investigationQueue, { key }),
      ])
    ).flat();
    if (jobs.some((job) => !terminalRemediationJobStates.has(job.state))) {
      continue;
    }
    if (
      await recoverAbandonedIssuePullRequest(
        candidate.requestId,
        staleBefore,
      )
    ) {
      recovered.push(candidate.requestId);
    }
  }

  return recovered;
}

export async function queueIssueRemediationJob(
  queue: RemediationJobQueue,
  requestId: string,
) {
  let claimed = false;
  try {
    const remediation = await getIssuePullRequestForRemediation(requestId);
    if (remediation.status !== "queued") {
      throw new Error("Pull request request is no longer active");
    }

    const config = await getRuntimeAgentConfig(
      remediation.agentConfigVersionId,
    );
    if (!config) throw new Error("Agent configuration is unavailable");

    await claimIssuePullRequestForRemediation(remediation.requestId);
    claimed = true;
    const jobId = await queue.send(
      remediationQueue,
      {
        kind: "remediation",
        config,
        investigationId: remediation.investigationId,
        issue: {
          id: remediation.issueId,
          title: remediation.issueTitle,
          description: remediation.issueDescription,
          rootCause: remediation.issueRootCause,
          timeline: remediation.issueTimeline,
          severity: remediation.issueSeverity,
          remediation: remediation.issueRemediation,
          evidence: remediation.issueEvidence,
        },
        queuedAt: new Date().toISOString(),
        remediationRequestId: remediation.requestId,
        runtimeProfileId: remediation.runtimeProfileId,
      },
      { singletonKey: `remediation:${remediation.requestId}` },
    );
    if (!jobId) {
      // An exclusive-queue collision means an existing job owns this request;
      // do not let the losing enqueue attempt fail the winner's database row.
      claimed = false;
      console.error(
        JSON.stringify({
          error: "The remediation job was not created",
          event: "remediation_job_not_created",
          requestId: remediation.requestId,
        }),
      );
      throw new Error("The remediation job was not created");
    }

    try {
      await setIssuePullRequestSession(
        remediation.requestId,
        `openai-daytona:${jobId}`,
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          event: "remediation_session_record_failed",
          jobId,
          requestId: remediation.requestId,
        }),
      );
    }
    return { jobId, requestId: remediation.requestId };
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        event: "remediation_queue_failed",
        requestId,
      }),
    );
    if (claimed) {
      await failIssuePullRequest(
        requestId,
        error instanceof Error ? error.message : "Unable to start remediation",
      );
    }
    throw error;
  }
}
