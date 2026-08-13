import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  failIssuePullRequest: vi.fn(),
  getIssuePullRequestForRemediation: vi.fn(),
  getRuntimeAgentConfig: vi.fn(),
  markIssuePullRequestStarted: vi.fn(),
  setIssuePullRequestSession: vi.fn(),
}));

vi.mock("./db/investigations.js", () => ({
  getRuntimeAgentConfig: mocks.getRuntimeAgentConfig,
}));
vi.mock("./db/pull-requests.js", () => ({
  failIssuePullRequest: mocks.failIssuePullRequest,
  getIssuePullRequestForRemediation: mocks.getIssuePullRequestForRemediation,
  markIssuePullRequestStarted: mocks.markIssuePullRequestStarted,
  setIssuePullRequestSession: mocks.setIssuePullRequestSession,
}));

import { queueIssueRemediationJob } from "./remediation-queue.js";

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
    mocks.markIssuePullRequestStarted.mockImplementationOnce(async () => {
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
      "responder-investigations",
      expect.objectContaining({
        kind: "remediation",
        remediationRequestId: requestId,
        issue: expect.objectContaining({ id: remediation.issueId }),
      }),
      { singletonKey: `remediation:${requestId}` },
    );
    expect(mocks.markIssuePullRequestStarted).toHaveBeenCalledWith(requestId);
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

  it("marks a request failed when its remediation details cannot be loaded", async () => {
    const lookupError = new Error("database unavailable");
    mocks.getIssuePullRequestForRemediation.mockRejectedValue(lookupError);
    const queue = { send: vi.fn() };

    await expect(
      queueIssueRemediationJob(queue, requestId),
    ).rejects.toBe(lookupError);
    expect(mocks.failIssuePullRequest).toHaveBeenCalledWith(
      requestId,
      "database unavailable",
    );
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

  it("logs a null job result before recording the request failure", async () => {
    const calls: string[] = [];
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation((message) => {
        const event = JSON.parse(String(message)) as { event: string };
        calls.push(event.event);
      });
    mocks.failIssuePullRequest.mockImplementationOnce(async () => {
      calls.push("fail");
    });
    const queue = { send: vi.fn().mockResolvedValue(null) };

    await expect(
      queueIssueRemediationJob(queue, requestId),
    ).rejects.toThrow("The remediation job was not created");
    expect(calls).toEqual([
      "remediation_job_not_created",
      "remediation_queue_failed",
      "fail",
    ]);

    consoleError.mockRestore();
  });
});
