import type { PullRequestReviewJob } from "@responder/core/jobs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { processPullRequestReviewJob } from "./pull-request-review-job.js";

const mocks = vi.hoisted(() => ({
  appendActivity: vi.fn(),
  captureAnalytics: vi.fn(),
  reportException: vi.fn(),
  runAgent: vi.fn(),
}));

vi.mock("@responder/core/analytics", () => ({
  captureAnalyticsEvent: mocks.captureAnalytics,
}));

vi.mock("@responder/core/db/pull-requests", () => ({
  appendIssuePullRequestActivity: mocks.appendActivity,
  pullRequestActivityEvent: (
    type: string,
    data?: Record<string, unknown>,
  ) => ({ data, meta: { at: "2026-08-25T10:00:00.000Z" }, type }),
}));

vi.mock("./monitoring.js", () => ({
  reportWorkerException: mocks.reportException,
}));

vi.mock("./review-pull-request.js", () => ({
  runPullRequestReviewAgent: mocks.runAgent,
}));

const payload: PullRequestReviewJob = {
  kind: "pull_request_review",
  config: {
    agentId: "13131313-1313-4313-8313-131313131313",
    id: "08080808-0808-4808-8808-080808080808",
    model: "instance/default",
    organizationId: "15151515-1515-4515-8515-151515151515",
    prMode: "manual",
    prompt: "Fix carefully.",
  },
  installationId: 123,
  investigationId: "16161616-1616-4616-8616-161616161616",
  issue: {
    description: "The route throws.",
    evidence: [],
    id: "10101010-1010-4010-8010-101010101010",
    remediation: "Handle the missing value.",
    rootCause: "A value is missing.",
    severity: "SEV-2",
    timeline: [],
    title: "Broken route",
  },
  pullRequest: {
    branch: "fix/broken-route",
    number: 42,
    repository: "acme/app",
  },
  queuedAt: "2026-08-25T09:59:00.000Z",
  requestId: "05050505-0505-4505-8505-050505050505",
  runtimeProfileId: "19191919-1919-4919-8919-191919191919",
};

describe("pull request review activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appendActivity.mockResolvedValue(undefined);
    mocks.captureAnalytics.mockResolvedValue(undefined);
    mocks.reportException.mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("records traces, the pushed commit, addressed threads, and completion", async () => {
    mocks.runAgent.mockImplementation(
      async (
        _payload: PullRequestReviewJob,
        _environment: NodeJS.ProcessEnv,
        onTrace: (event: Record<string, unknown>) => Promise<void>,
      ) => {
        await onTrace({
          data: { actions: [{ toolName: "apply_patch" }] },
          meta: { at: "2026-08-25T10:01:00.000Z" },
          type: "actions.requested",
        });
        return {
          addressedThreads: 1,
          changedFiles: ["src/route.ts"],
          commitMessage: "Address review feedback",
          headSha: "abc123",
          responses: [{ body: "Fixed in abc123.", threadId: "thread-1" }],
        };
      },
    );

    await expect(
      processPullRequestReviewJob("job-1", payload, {}),
    ).resolves.toEqual({ requestId: payload.requestId });

    expect(mocks.appendActivity).toHaveBeenCalledTimes(5);
    expect(mocks.appendActivity.mock.calls.map(([input]) => input.event.type)).toEqual([
      "review.session.started",
      "review.trace",
      "review.commit.pushed",
      "review.threads.addressed",
      "review.session.completed",
    ]);
    expect(mocks.appendActivity).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        event: expect.objectContaining({
          data: expect.objectContaining({
            files: ["src/route.ts"],
            message: "Address review feedback",
            sha: "abc123",
          }),
        }),
        externalKey: "review-job:job-1:commit:abc123",
      }),
    );
  });

  it("records a terminal activity when the review fails", async () => {
    const failure = new Error("review failed");
    mocks.runAgent.mockRejectedValue(failure);

    await expect(
      processPullRequestReviewJob("job-2", payload, {}),
    ).rejects.toThrow("review failed");

    expect(mocks.appendActivity.mock.calls.map(([input]) => input.event.type)).toEqual([
      "review.session.started",
      "review.session.failed",
    ]);
    expect(mocks.reportException).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({ jobId: "job-2", requestId: payload.requestId }),
    );
  });
});
