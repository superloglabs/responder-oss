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
    const issueId = "12121212-1212-4212-8212-121212121212";
    const requestId = "05050505-0505-4505-8505-050505050505";
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
      agentConfigVersionId: "08080808-0808-4808-8808-080808080808",
      investigationId: "16161616-1616-4616-8616-161616161616",
      organizationId: "15151515-1515-4515-8515-151515151515",
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
