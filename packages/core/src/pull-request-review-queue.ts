import { getRuntimeAgentConfig } from "./db/investigations.js";
import { getIssuePullRequestForReview } from "./db/pull-requests.js";
import {
  pullRequestReviewQueue,
  type PullRequestReviewJob,
} from "./jobs.js";

export interface PullRequestReviewJobQueue {
  send(
    name: string,
    data: PullRequestReviewJob,
    options: { singletonKey: string },
  ): Promise<string | null>;
}

export async function queuePullRequestReviewJob(
  queue: PullRequestReviewJobQueue,
  input: {
    installationId: number;
    pullRequestNumber: number;
    repositoryFullName: string;
  },
) {
  const review = await getIssuePullRequestForReview(input);
  if (!review) return { matched: false as const };

  const config = await getRuntimeAgentConfig(review.agentConfigVersionId);
  if (!config) throw new Error("Agent configuration is unavailable");

  const jobId = await queue.send(
    pullRequestReviewQueue,
    {
      kind: "pull_request_review",
      config,
      installationId: input.installationId,
      investigationId: review.investigationId,
      issue: {
        id: review.issueId,
        title: review.issueTitle,
        description: review.issueDescription,
        rootCause: review.issueRootCause,
        timeline: review.issueTimeline,
        severity: review.issueSeverity,
        remediation: review.issueRemediation,
        evidence: review.issueEvidence,
      },
      pullRequest: {
        branch: review.branch,
        number: input.pullRequestNumber,
        repository: input.repositoryFullName,
      },
      queuedAt: new Date().toISOString(),
      requestId: review.requestId,
      runtimeProfileId: review.runtimeProfileId,
    },
    { singletonKey: `pull-request-review:${review.requestId}` },
  );

  return {
    matched: true as const,
    queued: jobId !== null,
    requestId: review.requestId,
    ...(jobId ? { jobId } : {}),
  };
}
