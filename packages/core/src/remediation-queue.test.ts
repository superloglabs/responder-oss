import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimIssuePullRequestForRemediation: vi.fn(),
  failIssuePullRequest: vi.fn(),
  listStaleCreatingIssuePullRequests: vi.fn(),
  recoverAbandonedIssuePullRequest: vi.fn(),
  getIssuePullRequestForRemediation: vi.fn(),
  getRuntimeAgentConfig: vi.fn(),
  setIssuePullRequestSession: vi.fn(),
}));

vi.mock("./db/investigations.js", () => ({
  getRuntimeAgentConfig: mocks.getRuntimeAgentConfig,
}));
vi.mock("./db/pull-requests.js", () => ({
  claimIssuePullRequestForRemediation:
    mocks.claimIssuePullRequestForRemediation,
  failIssuePullRequest: mocks.failIssuePullRequest,
  listStaleCreatingIssuePullRequests:
    mocks.listStaleCreatingIssuePullRequests,
  recoverAbandonedIssuePullRequest:
    mocks.recoverAbandonedIssuePullRequest,
  getIssuePullRequestForRemediation: mocks.getIssuePullRequestForRemediation,
  setIssuePullRequestSession: mocks.setIssuePullRequestSession,
}));

import {
  queueIssueRemediationJob,
  recoverAbandonedIssueRemediations,
} from "./remediation-queue.js";

const requestId = "05050505-0505-4505-8505-050505050505";
const remediation = {
  requestId,
  issueId: "10101010-1010-4010-8010-101010101010",
  issueTitle: "Broken route",
  issueDescription: "The route throws.",
  issueSeverity: "SEV-2" as const,
  issueRemediation: "Handle the missing value.",
  issueEvidence: [],
  investigationId: "16161616-1616-4616-8616-161616161616",
  agentConfigVersionId: "08080808-0808-4808-8808-080808080808",
  agentId: "13131313-1313-4313-8313-131313131313",
  organizationId: "15151515-1515-4515-8515-151515151515",
  runtimeProfileId: "19191919-1919-4919-8919-191919191919",
  status: "queued" as const,
};
const config = {
  agentId: remediation.agentId,
  id: remediation.agentConfigVersionId,
  model: "instance/default",
  organizationId: remediation.organizationId,
  prMode: "always" as const,
  prompt: "Investigate carefully.",
};

describe("remediation job queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getIssuePullRequestForRemediation.mockResolvedValue(remediation);
    mocks.getRuntimeAgentConfig.mockResolvedValue(config);
  });

  it("queues a dedicated remediation job and records its session", async () => {
    const calls: string[] = [];
    mocks.claimIssuePullRequestForRemediation.mockImplementationOnce(async () => {
      calls.push("started");
    });
    const queue = {
      send: vi.fn(async () => {
        calls.push("sent");
        return "job-id";
      }),
    };

    await expect(
      queueIssueRemediationJob(queue, requestId),
    ).resolves.toEqual({ jobId: "job-id", requestId });

    expect(queue.send).toHaveBeenCalledWith(
      "responder-remediations-v2",
      expect.objectContaining({
        kind: "remediation",
        remediationRequestId: requestId,
        issue: expect.objectContaining({ id: remediation.issueId }),
      }),
      { singletonKey: `remediation:${requestId}` },
    );
    expect(
      mocks.claimIssuePullRequestForRemediation,
    ).toHaveBeenCalledWith(requestId);
    expect(calls).toEqual(["started", "sent"]);
    expect(mocks.setIssuePullRequestSession).toHaveBeenCalledWith(
      requestId,
      "openai-daytona:job-id",
    );
  });

  it("marks a request failed when its remediation job cannot be queued", async () => {
    const queueError = new Error("queue unavailable");
    const queue = { send: vi.fn().mockRejectedValue(queueError) };

    await expect(
      queueIssueRemediationJob(queue, requestId),
    ).rejects.toBe(queueError);
    expect(mocks.failIssuePullRequest).toHaveBeenCalledWith(
      requestId,
      "queue unavailable",
    );
  });

  it("does not mutate a request when its remediation details cannot be loaded", async () => {
    const lookupError = new Error("database unavailable");
    mocks.getIssuePullRequestForRemediation.mockRejectedValue(lookupError);
    const queue = { send: vi.fn() };

    await expect(
      queueIssueRemediationJob(queue, requestId),
    ).rejects.toBe(lookupError);
    expect(mocks.failIssuePullRequest).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("keeps an accepted job active when recording its session fails", async () => {
    const sessionError = new Error("session metadata unavailable");
    mocks.setIssuePullRequestSession.mockRejectedValue(sessionError);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const queue = { send: vi.fn().mockResolvedValue("job-id") };

    await expect(
      queueIssueRemediationJob(queue, requestId),
    ).resolves.toEqual({ jobId: "job-id", requestId });
    expect(mocks.failIssuePullRequest).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      JSON.stringify({
        error: "session metadata unavailable",
        event: "remediation_session_record_failed",
        jobId: "job-id",
        requestId,
      }),
    );

    consoleError.mockRestore();
  });

  it("does not fail the winning request after an exclusive-queue collision", async () => {
    const calls: string[] = [];
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation((message) => {
        const event = JSON.parse(String(message)) as { event: string };
        calls.push(event.event);
      });
    const queue = { send: vi.fn().mockResolvedValue(null) };

    await expect(
      queueIssueRemediationJob(queue, requestId),
    ).rejects.toThrow("The remediation job was not created");
    expect(calls).toEqual([
      "remediation_job_not_created",
      "remediation_queue_failed",
    ]);
    expect(mocks.failIssuePullRequest).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it("does not let a losing concurrent claim fail the winning request", async () => {
    const claimError = new Error("Pull request request is no longer active");
    mocks.claimIssuePullRequestForRemediation.mockRejectedValue(claimError);
    const queue = { send: vi.fn() };

    await expect(
      queueIssueRemediationJob(queue, requestId),
    ).rejects.toBe(claimError);
    expect(queue.send).not.toHaveBeenCalled();
    expect(mocks.failIssuePullRequest).not.toHaveBeenCalled();
  });
});

describe("abandoned remediation recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recovers only stale requests without a queued or active job", async () => {
    const activeRequestId = "05050505-0505-4505-8505-050505050505";
    const abandonedRequestId = "06060606-0606-4606-8606-060606060606";
    const now = new Date("2026-08-17T14:00:00.000Z");
    mocks.listStaleCreatingIssuePullRequests.mockResolvedValue([
      { requestId: activeRequestId },
      { requestId: abandonedRequestId },
    ]);
    mocks.recoverAbandonedIssuePullRequest.mockResolvedValue(true);
    const queue = {
      findJobs: vi.fn(async (_name: string, options: { key: string }) =>
        options.key === `remediation:${activeRequestId}`
          ? [{ state: "active" as const }]
          : [{ state: "failed" as const }]
      ),
    };

    await expect(
      recoverAbandonedIssueRemediations(queue, now),
    ).resolves.toEqual([abandonedRequestId]);

    const staleBefore = new Date("2026-08-17T12:00:00.000Z");
    expect(mocks.listStaleCreatingIssuePullRequests).toHaveBeenCalledWith(
      staleBefore,
    );
    expect(queue.findJobs).toHaveBeenCalledWith(
      "responder-remediations-v2",
      { key: `remediation:${activeRequestId}` },
    );
    expect(mocks.recoverAbandonedIssuePullRequest).toHaveBeenCalledExactlyOnceWith(
      abandonedRequestId,
      staleBefore,
    );
  });

  it("does not report a request whose atomic stale check loses a race", async () => {
    const requestId = "06060606-0606-4606-8606-060606060606";
    mocks.listStaleCreatingIssuePullRequests.mockResolvedValue([{ requestId }]);
    mocks.recoverAbandonedIssuePullRequest.mockResolvedValue(false);
    const queue = {
      findJobs: vi.fn().mockResolvedValue([]),
    };

    await expect(
      recoverAbandonedIssueRemediations(
        queue,
        new Date("2026-08-17T14:00:00.000Z"),
      ),
    ).resolves.toEqual([]);
  });

  it("keeps a stale request active while its legacy queue job is live", async () => {
    const requestId = "06060606-0606-4606-8606-060606060606";
    mocks.listStaleCreatingIssuePullRequests.mockResolvedValue([{ requestId }]);
    const queue = {
      findJobs: vi.fn(async (name: string) =>
        name === "responder-investigations"
          ? [{ state: "active" as const }]
          : []
      ),
    };

    await expect(
      recoverAbandonedIssueRemediations(
        queue,
        new Date("2026-08-17T14:00:00.000Z"),
      ),
    ).resolves.toEqual([]);
    expect(queue.findJobs).toHaveBeenCalledWith(
      "responder-investigations",
      { key: `remediation:${requestId}` },
    );
    expect(mocks.recoverAbandonedIssuePullRequest).not.toHaveBeenCalled();
  });

  it.each(["created", "retry", "active"])(
    "keeps a stale request with a %s job active",
    async (state) => {
      const requestId = "06060606-0606-4606-8606-060606060606";
      mocks.listStaleCreatingIssuePullRequests.mockResolvedValue([{ requestId }]);
      const queue = {
        findJobs: vi.fn().mockResolvedValue([{ state }]),
      };

      await expect(
        recoverAbandonedIssueRemediations(
          queue,
          new Date("2026-08-17T14:00:00.000Z"),
        ),
      ).resolves.toEqual([]);
      expect(mocks.recoverAbandonedIssuePullRequest).not.toHaveBeenCalled();
    },
  );

  it.each(["completed", "failed", "cancelled"])(
    "recovers a stale request with a %s job",
    async (state) => {
      const requestId = "06060606-0606-4606-8606-060606060606";
      mocks.listStaleCreatingIssuePullRequests.mockResolvedValue([{ requestId }]);
      mocks.recoverAbandonedIssuePullRequest.mockResolvedValue(true);
      const queue = {
        findJobs: vi.fn().mockResolvedValue([{ state }]),
      };

      await expect(
        recoverAbandonedIssueRemediations(
          queue,
          new Date("2026-08-17T14:00:00.000Z"),
        ),
      ).resolves.toEqual([requestId]);
    },
  );
});
