import { captureAnalyticsEvent } from "@responder/core/analytics";
import type { PullRequestReviewJob } from "@responder/core/jobs";
import { safeInvestigationError } from "./investigate.js";
import { reportWorkerException } from "./monitoring.js";
import { runPullRequestReviewAgent } from "./review-pull-request.js";

export async function processPullRequestReviewJob(
  jobId: string,
  payload: PullRequestReviewJob,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ requestId: string }> {
  try {
    const result = await runPullRequestReviewAgent(payload, environment);
    await captureAnalyticsEvent({
      distinctId: `investigation:${payload.investigationId}`,
      event: "pr review addressed",
      organizationId: payload.config.organizationId,
      properties: {
        $process_person_profile: false,
        addressed_threads: result.addressedThreads,
        agent_config_version_id: payload.config.id,
        changed_files: result.changedFiles.length,
        investigation_id: payload.investigationId,
        issue_id: payload.issue.id,
        pr_number: payload.pullRequest.number,
        repository: payload.pullRequest.repository,
      },
    });
    console.log(
      JSON.stringify({
        addressedThreads: result.addressedThreads,
        changedFiles: result.changedFiles.length,
        event: "pull_request_review_job_complete",
        jobId,
        requestId: payload.requestId,
      }),
    );
    return { requestId: payload.requestId };
  } catch (error) {
    console.error(
      JSON.stringify({
        error: safeInvestigationError(error, environment),
        event: "pull_request_review_job_failed",
        jobId,
        requestId: payload.requestId,
      }),
    );
    await reportWorkerException(error, {
      investigationId: payload.investigationId,
      jobId,
      operation: "pull_request_review",
      organizationId: payload.config.organizationId,
      requestId: payload.requestId,
    });
    throw error;
  }
}
