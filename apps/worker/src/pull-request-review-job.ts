import { captureAnalyticsEvent } from "@responder/core/analytics";
import {
  appendIssuePullRequestActivity,
  pullRequestActivityEvent,
} from "@responder/core/db/pull-requests";
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
    await appendIssuePullRequestActivity({
      event: pullRequestActivityEvent("review.session.started", { jobId }),
      externalKey: `review-job:${jobId}:started`,
      requestId: payload.requestId,
    });
    let traceIndex = 0;
    const result = await runPullRequestReviewAgent(
      payload,
      environment,
      async (event) => {
        const index = traceIndex++;
        await appendIssuePullRequestActivity({
          event: pullRequestActivityEvent("review.trace", { event, jobId }),
          externalKey: `review-job:${jobId}:trace:${index}`,
          requestId: payload.requestId,
        });
      },
    );
    if (result.changedFiles.length > 0) {
      await appendIssuePullRequestActivity({
        event: pullRequestActivityEvent("review.commit.pushed", {
          files: result.changedFiles,
          message: result.commitMessage,
          sha: result.headSha,
        }),
        externalKey: `review-job:${jobId}:commit:${result.headSha}`,
        requestId: payload.requestId,
      });
    }
    if (result.addressedThreads > 0) {
      await appendIssuePullRequestActivity({
        event: pullRequestActivityEvent("review.threads.addressed", {
          count: result.addressedThreads,
          responses: result.responses,
        }),
        externalKey: `review-job:${jobId}:threads-addressed`,
        requestId: payload.requestId,
      });
    }
    await appendIssuePullRequestActivity({
      event: pullRequestActivityEvent("review.session.completed", {
        addressedThreads: result.addressedThreads,
        changedFiles: result.changedFiles.length,
        jobId,
      }),
      externalKey: `review-job:${jobId}:completed`,
      requestId: payload.requestId,
    });
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
    const safeError = safeInvestigationError(error, environment);
    try {
      await appendIssuePullRequestActivity({
        event: pullRequestActivityEvent("review.session.failed", {
          error: safeError,
          jobId,
        }),
        externalKey: `review-job:${jobId}:failed`,
        requestId: payload.requestId,
      });
    } catch (activityError) {
      console.error(
        JSON.stringify({
          error: safeInvestigationError(activityError, environment),
          event: "pull_request_review_activity_failed",
          jobId,
          requestId: payload.requestId,
        }),
      );
    }
    console.error(
      JSON.stringify({
        error: safeError,
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
