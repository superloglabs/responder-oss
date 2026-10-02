import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import { createThreadPullRequestTool } from "./thread-pull-request.js";

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
  }, {
    captureEvent: vi.fn().mockResolvedValue(undefined),
    createPullRequest,
    getRepositories: vi.fn().mockResolvedValue(
      overrides.repositories ?? [{ fullName: "acme/api", installationId: 7 }],
    ),
  });
  return { createPullRequest, tool };
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
