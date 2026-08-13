import { getRuntimeAgentConfig } from "./db/investigations.js";
import {
  failIssuePullRequest,
  getIssuePullRequestForRemediation,
  markIssuePullRequestStarted,
  setIssuePullRequestSession,
} from "./db/pull-requests.js";
import { investigationQueue, type RemediationJob } from "./jobs.js";

export interface RemediationJobQueue {
  send(
    name: string,
    data: RemediationJob,
    options: { singletonKey: string },
  ): Promise<string | null>;
}

export async function queueIssueRemediationJob(
  queue: RemediationJobQueue,
  requestId: string,
) {
  try {
    const remediation = await getIssuePullRequestForRemediation(requestId);
    if (!["queued", "creating"].includes(remediation.status)) {
      throw new Error("Pull request request is no longer active");
    }

    const config = await getRuntimeAgentConfig(
      remediation.agentConfigVersionId,
    );
    if (!config) throw new Error("Agent configuration is unavailable");

    await markIssuePullRequestStarted(remediation.requestId);
    const jobId = await queue.send(
      investigationQueue,
      {
        kind: "remediation",
        config,
        investigationId: remediation.investigationId,
        issue: {
          id: remediation.issueId,
          title: remediation.issueTitle,
          description: remediation.issueDescription,
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
    await failIssuePullRequest(
      requestId,
      error instanceof Error ? error.message : "Unable to start remediation",
    );
    throw error;
  }
}
