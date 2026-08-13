import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeRepositories } from "@responder/core/db/investigations";
import {
  getExecutableIssuePullRequest,
  markIssuePullRequestCreated,
} from "@responder/core/db/pull-requests";
import { createPullRequestFromSandbox } from "./github-pull-request.js";
import { createPullRequestTool } from "./pull-request.js";

vi.mock("@responder/core/db/investigations", () => ({
  getRuntimeRepositories: vi.fn(),
}));
vi.mock("@responder/core/db/pull-requests", () => ({
  failIssuePullRequest: vi.fn(),
  getExecutableIssuePullRequest: vi.fn(),
  markIssuePullRequestCreated: vi.fn(),
  markIssuePullRequestStarted: vi.fn(),
}));
vi.mock("./github-pull-request.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-pull-request.js")>()),
  createPullRequestFromSandbox: vi.fn(),
}));

describe("pull request tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes changes only for its assigned remediation request", async () => {
    const issueId = "7ad47787-0efa-4ce3-b1d7-2f14bcfcd4e9";
    const requestId = "4614c371-a4a3-4342-a9a8-36e526377345";
    const manifest = {
      repositories: [
        {
          branch: "main",
          path: "/home/daytona/workspace/repositories/acme/service",
          repository: "acme/service",
          sha: "a".repeat(40),
          workspaceBaseSha: "b".repeat(40),
        },
      ],
    };
    const session = {
      readFile: vi.fn().mockResolvedValue(
        new TextEncoder().encode(JSON.stringify(manifest)),
      ),
    } as unknown as DaytonaSandboxSession;
    vi.mocked(getExecutableIssuePullRequest).mockResolvedValue({
      requestId,
      issueTitle: "Broken route",
      issueDescription: "The route throws.",
      issueRemediation: "Handle the missing value.",
      status: "creating",
    });
    vi.mocked(getRuntimeRepositories).mockResolvedValue([
      {
        defaultBranch: "main",
        fullName: "acme/service",
        installationId: 42,
        private: true,
      },
    ]);
    vi.mocked(createPullRequestFromSandbox).mockResolvedValue({
      branch: "fix/broken-route",
      changedFiles: ["src/route.ts"],
      number: 17,
      url: "https://github.com/acme/service/pull/17",
    });
    const pullRequestTool = createPullRequestTool({
      agentConfigVersionId: "684a11c5-f5b8-4ff5-b157-592e04164dd3",
      investigationId: "9ec74cbd-b9bd-452b-932f-19bc64084203",
      organizationId: "9ba9e0a6-b15c-4674-bf91-18d70b6ff450",
      pullRequestRequestId: requestId,
      session,
    });

    await expect(
      pullRequestTool.invoke(
        undefined as never,
        JSON.stringify({
          issueId,
          repository: "acme/service",
          summary: "Handle the unchecked value.",
          testing: "Added a regression test.",
        }),
      ),
    ).resolves.toEqual({
      created: true,
      changedFiles: ["src/route.ts"],
      pullRequestNumber: 17,
      pullRequestUrl: "https://github.com/acme/service/pull/17",
    });
    expect(getExecutableIssuePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ issueId, requestId }),
    );
    expect(markIssuePullRequestCreated).toHaveBeenCalledWith({
      requestId,
      repositoryFullName: "acme/service",
      branch: "fix/broken-route",
      pullRequestNumber: 17,
      pullRequestUrl: "https://github.com/acme/service/pull/17",
    });
  });
});
