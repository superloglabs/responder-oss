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

const requestId = "4614c371-a4a3-4342-a9a8-36e526377345";
const remediation = {
  requestId,
  issueId: "6e55b174-e903-4d76-973f-9dff4a4e9883",
  issueTitle: "Broken route",
  issueDescription: "The route throws.",
  issueSeverity: "SEV-2" as const,
  issueRemediation: "Handle the missing value.",
  issueEvidence: [],
  investigationId: "9ec74cbd-b9bd-452b-932f-19bc64084203",
  agentConfigVersionId: "684a11c5-f5b8-4ff5-b157-592e04164dd3",
  agentId: "7f83b096-1299-47d3-bd10-d617463a15d1",
  organizationId: "9ba9e0a6-b15c-4674-bf91-18d70b6ff450",
  runtimeProfileId: "cf72339f-a631-448f-b8af-f9d8336ad879",
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
