import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import {
  createThreadPullRequestFollowUpTools,
  createThreadPullRequestTool,
  pullRequestReviewOf,
} from "./thread-pull-request.js";

const checkout = {
  branch: "main",
  path: "/home/daytona/workspace/repositories/acme/api",
  repository: "acme/api",
  sha: "a".repeat(40),
  workspaceBaseSha: "b".repeat(40),
};

function pullRequestTool(overrides: {
  repositories?: Array<{ fullName: string; installationId: number }>;
} = {}) {
  const recordOrigin = vi.fn().mockResolvedValue(undefined);
  const createPullRequest = vi.fn().mockResolvedValue({
    branch: "fix/add-retries-12345678",
    changedFiles: ["src/client.ts"],
    number: 42,
    url: "https://github.com/acme/api/pull/42",
  });
  const tool = createThreadPullRequestTool({
    agentConfigVersionId: "version-1",
    investigationId: "investigation-1",
    organizationId: "organization-1",
    repositories: [checkout],
    session: {} as DaytonaSandboxSession,
    slackInvestigationSessionId: "session-1",
  }, {
    captureEvent: vi.fn().mockResolvedValue(undefined),
    createPullRequest,
    getRepositories: vi.fn().mockResolvedValue(
      overrides.repositories ?? [{ fullName: "acme/api", installationId: 7 }],
    ),
    recordOrigin,
  });
  return { createPullRequest, recordOrigin, tool };
}

const request = JSON.stringify({
  body: "Adds retries to the API client.",
  repository: "acme/api",
  title: "Add retries",
});

describe("Slack thread pull requests", () => {
  it("opens a pull request from the checkout against its branch", async () => {
    const { createPullRequest, tool } = pullRequestTool();

    await expect(tool.invoke(undefined as never, request)).resolves.toMatchObject({
      number: 42,
      url: "https://github.com/acme/api/pull/42",
    });
    expect(createPullRequest).toHaveBeenCalledWith(expect.objectContaining({
      baseBranch: "main",
      baseSha: checkout.sha,
      installationId: 7,
      repository: "acme/api",
      repositoryPath: checkout.path,
      title: "Add retries",
      workspaceBaseSha: checkout.workspaceBaseSha,
    }), expect.anything());
  });

  it("records the thread as the pull request's origin, so a review continues it", async () => {
    const { recordOrigin, tool } = pullRequestTool();

    await tool.invoke(undefined as never, request);
    expect(recordOrigin).toHaveBeenCalledWith({
      organizationId: "organization-1",
      pullRequestNumber: 42,
      repositoryFullName: "acme/api",
      slackInvestigationSessionId: "session-1",
    });
  });

  it("reports a failed origin write and retries it when called again", async () => {
    const { createPullRequest, recordOrigin, tool } = pullRequestTool();
    recordOrigin.mockRejectedValueOnce(new Error("connection reset"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(tool.invoke(undefined as never, request)).resolves.toMatchObject({
      number: 42,
      warning: expect.stringContaining("cannot reach this thread yet"),
    });
    const retried = await tool.invoke(undefined as never, request);
    expect(retried).toMatchObject({ number: 42, note: "This pull request was already opened." });
    expect(retried).not.toHaveProperty("warning");
    expect(recordOrigin).toHaveBeenCalledTimes(2);
    expect(createPullRequest).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logged.mock.calls[0]![0] as string)).toEqual({
      errorCode: "Error",
      event: "pull_request_origin_record_failed",
      slackInvestigationSessionId: "session-1",
    });
    logged.mockRestore();
  });

  it("returns the pull request it already opened for the same title", async () => {
    const { createPullRequest, tool } = pullRequestTool();

    await tool.invoke(undefined as never, request);
    await expect(tool.invoke(undefined as never, request)).resolves.toMatchObject({
      note: "This pull request was already opened.",
      url: "https://github.com/acme/api/pull/42",
    });
    expect(createPullRequest).toHaveBeenCalledTimes(1);
  });

  it("refuses a repository that is no longer selected for tag mode", async () => {
    const { createPullRequest, tool } = pullRequestTool({ repositories: [] });

    await expect(tool.invoke(undefined as never, request)).resolves.toContain(
      "The repository is not selected for tag mode",
    );
    expect(createPullRequest).not.toHaveBeenCalled();
  });
});

describe("Slack thread pull request follow-up", () => {
  function followUp(owned = true) {
    const deps = {
      checkoutAtRef: vi.fn(),
      checkoutPullRequest: vi.fn().mockResolvedValue({
        checkout: { ...checkout, branch: "fix/add-retries-12345678" },
        head: { branch: "fix/add-retries-12345678", sha: "c".repeat(40), url: "https://github.com/acme/api/pull/42" },
        replaced: true,
      }),
      getOwnedPullRequest: vi.fn().mockResolvedValue(owned
        ? { branch: "fix/add-retries-12345678", pullRequestNumber: 42, repositoryFullName: "acme/api" }
        : null),
      getRepositories: vi.fn().mockResolvedValue([{ fullName: "acme/api", installationId: 7 }]),
      replyToComment: vi.fn().mockResolvedValue({ resolved: true }),
      updatePullRequest: vi.fn().mockResolvedValue({ changedFiles: ["src/client.ts"], headSha: "d".repeat(40), url: "https://github.com/acme/api/pull/42" }),
    };
    const result = createThreadPullRequestFollowUpTools({
      agentConfigVersionId: "version-1",
      repositories: [checkout],
      session: {} as DaytonaSandboxSession,
      slackInvestigationSessionId: "session-1",
    }, deps);
    const tool = (name: string) => result.tools.find((candidate) => candidate.name === name)!;
    return { deps, result, tool };
  }

  it("pushes to a pull request the thread opened, with the repository's installation", async () => {
    const { deps, tool } = followUp();

    await expect(tool("update_pull_request").invoke(undefined as never, JSON.stringify({
      commitMessage: "Handle the empty response",
      pullRequestNumber: 42,
      repository: "acme/api",
    }))).resolves.toMatchObject({ headSha: "d".repeat(40) });
    expect(deps.getOwnedPullRequest).toHaveBeenCalledWith({
      pullRequestNumber: 42,
      repositoryFullName: "acme/api",
      slackInvestigationSessionId: "session-1",
    });
    expect(deps.updatePullRequest).toHaveBeenCalledWith(expect.objectContaining({
      commitMessage: "Handle the empty response",
      target: { installationId: 7, number: 42, repository: "acme/api" },
    }));
  });

  it("refuses pull requests the thread did not open", async () => {
    const { deps, result, tool } = followUp(false);

    await expect(tool("reply_to_pull_request_comment").invoke(undefined as never, JSON.stringify({
      body: "Done.",
      commentId: 5,
      pullRequestNumber: 7,
      repository: "acme/api",
      resolve: true,
    }))).resolves.toContain("This thread did not open that pull request");
    await expect(result.checkout({ pullRequestNumber: 7, repository: "acme/api" }))
      .rejects.toThrow("This thread did not open that pull request");
    expect(deps.replyToComment).not.toHaveBeenCalled();
    expect(deps.checkoutPullRequest).not.toHaveBeenCalled();
  });

  it("reads the reviewed pull request from a review turn's request", () => {
    expect(pullRequestReviewOf({ githubPullRequestNumber: 42, githubRepository: "acme/api" }))
      .toEqual({ pullRequestNumber: 42, repository: "acme/api" });
    expect(pullRequestReviewOf({ channelId: "C1" })).toBeNull();
    expect(pullRequestReviewOf({ githubPullRequestNumber: "42", githubRepository: "acme/api" })).toBeNull();
  });
});
