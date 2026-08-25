import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeAgentConfig } from "./db/investigations.js";
import {
  appendIssuePullRequestActivity,
  getIssuePullRequestForReview,
} from "./db/pull-requests.js";
import { pullRequestReviewQueue } from "./jobs.js";
import { queuePullRequestReviewJob } from "./pull-request-review-queue.js";

vi.mock("./db/investigations.js", () => ({
  getRuntimeAgentConfig: vi.fn(),
}));

vi.mock("./db/pull-requests.js", () => ({
  appendIssuePullRequestActivity: vi.fn(),
  getIssuePullRequestForReview: vi.fn(),
  pullRequestActivityEvent: (
    type: string,
    data?: Record<string, unknown>,
  ) => ({ type, data, meta: { at: "2026-08-25T00:00:00.000Z" } }),
}));

const reviewComment = {
  author: "reviewer-bot",
  body: "Use a null guard here.",
  id: 123,
  line: 17,
  path: "src/route.ts",
  url: "https://github.com/acme/app/pull/42#discussion_r123",
};

const review = {
  agentConfigVersionId: "08080808-0808-4808-8808-080808080808",
  branch: "fix/broken-route",
  investigationId: "16161616-1616-4616-8616-161616161616",
  issueDescription: "The route throws.",
  issueEvidence: [],
  issueId: "10101010-1010-4010-8010-101010101010",
  issueRemediation: "Handle the missing value.",
  issueRootCause: "A value is missing.",
  issueSeverity: "SEV-2" as const,
  issueTimeline: [],
  issueTitle: "Broken route",
  pullRequestNumber: 42,
  repositoryFullName: "acme/app",
  requestId: "05050505-0505-4505-8505-050505050505",
  runtimeProfileId: "19191919-1919-4919-8919-191919191919",
};

describe("pull request review queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIssuePullRequestForReview).mockResolvedValue(review);
    vi.mocked(getRuntimeAgentConfig).mockResolvedValue({
      agentId: "13131313-1313-4313-8313-131313131313",
      createLinearTickets: false,
      id: review.agentConfigVersionId,
      linearIssueTemplate: "",
      model: "instance/default",
      organizationId: "15151515-1515-4515-8515-151515151515",
      prMode: "manual",
      prompt: "Fix carefully.",
    });
  });

  it("queues a serialized review job for a known agent PR", async () => {
    const send = vi.fn().mockResolvedValue("job-1");

    await expect(
      queuePullRequestReviewJob(
        { send },
        {
          installationId: 123,
          pullRequestNumber: 42,
          reviewComment,
          repositoryFullName: "acme/app",
        },
      ),
    ).resolves.toEqual({
      jobId: "job-1",
      matched: true,
      queued: true,
      requestId: review.requestId,
    });
    expect(send).toHaveBeenCalledWith(
      pullRequestReviewQueue,
      expect.objectContaining({
        installationId: 123,
        kind: "pull_request_review",
        pullRequest: {
          branch: "fix/broken-route",
          number: 42,
          repository: "acme/app",
        },
      }),
      { singletonKey: `pull-request-review:${review.requestId}` },
    );
    expect(appendIssuePullRequestActivity).toHaveBeenCalledTimes(2);
    expect(appendIssuePullRequestActivity).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        externalKey: "github-review-comment:123",
        requestId: review.requestId,
      }),
    );
    expect(appendIssuePullRequestActivity).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        externalKey: "review-job:job-1:queued",
        requestId: review.requestId,
      }),
    );
  });

  it("ignores a review for a pull request Responder did not create", async () => {
    vi.mocked(getIssuePullRequestForReview).mockResolvedValue(null);
    const send = vi.fn();

    await expect(
      queuePullRequestReviewJob(
        { send },
        {
          installationId: 123,
          pullRequestNumber: 42,
          reviewComment,
          repositoryFullName: "acme/app",
        },
      ),
    ).resolves.toEqual({ matched: false });
    expect(send).not.toHaveBeenCalled();
  });
});
