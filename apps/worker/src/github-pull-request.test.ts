import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import { createPullRequestFromSandbox, pullRequestOpener } from "./github-pull-request.js";

vi.mock("@responder/core/db/github-pull-request-authors", () => ({
  githubPullRequestAuthorToken: vi.fn(),
  markGitHubPullRequestAuthorRejected: vi.fn(),
  recordMemberPullRequestBranch: vi.fn(),
}));

function dependencies(memberToken: { githubLogin: string; token: string } | null = null) {
  return {
    createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
    fetch: vi.fn<typeof fetch>(),
    markMemberTokenRejected: vi.fn().mockResolvedValue(undefined),
    memberToken: vi.fn().mockResolvedValue(memberToken),
    recordMemberBranch: vi.fn().mockResolvedValue(undefined),
  };
}

function commandResult(exitCode: number, output = "") {
  return `Chunk ID: abc123\nWall time: 0.0100 seconds\nProcess exited with code ${exitCode}\nOutput:\n${output}`;
}

describe("GitHub pull requests from Daytona", () => {
  it("publishes changed sandbox files without putting the GitHub token in Daytona", async () => {
    const execCommand = vi
      .fn()
      .mockResolvedValueOnce(commandResult(0, "src/route.ts\0"))
      .mockResolvedValueOnce(commandResult(0, "present"))
      .mockResolvedValueOnce(commandResult(1));
    const session = {
      execCommand,
      readFile: vi.fn().mockResolvedValue(new TextEncoder().encode("fixed\n")),
    } as unknown as DaytonaSandboxSession;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ tree: { sha: "base-tree-sha" } }))
      .mockResolvedValueOnce(Response.json({ sha: "blob-sha" }))
      .mockResolvedValueOnce(Response.json({ sha: "tree-sha" }))
      .mockResolvedValueOnce(Response.json({ sha: "commit-sha" }))
      .mockResolvedValueOnce(Response.json({ ref: "refs/heads/fix" }))
      .mockResolvedValueOnce(
        Response.json({ number: 42, html_url: "https://github.com/acme/app/pull/42" }),
      );

    await expect(
      createPullRequestFromSandbox(
        {
          baseBranch: "main",
          baseSha: "a".repeat(40),
          body: "Pull request body",
          installationId: 123,
          organizationId: "org-1",
          repository: "acme/app",
          repositoryPath: "/home/daytona/workspace/repositories/acme/app",
          requestId: "12345678-1234-1234-1234-123456789012",
          title: "Fix: Broken route",
          workspaceBaseSha: "b".repeat(40),
        },
        session,
        {
          ...dependencies(),
          fetch: fetchMock,
        },
      ),
    ).resolves.toEqual({
      branch: "fix/fix-broken-route-12345678",
      changedFiles: ["src/route.ts"],
      number: 42,
      url: "https://github.com/acme/app/pull/42",
    });
    expect(JSON.stringify(execCommand.mock.calls)).not.toContain("github-secret");
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.github.com/repos/acme/app/git/commits/${"a".repeat(40)}`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/app/git/blobs",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer github-secret" }),
      }),
    );
  });

  it("rejects a changed file containing a workspace secret placeholder", async () => {
    const session = {
      execCommand: vi
        .fn()
        .mockResolvedValueOnce(commandResult(0, "src/config.ts\0"))
        .mockResolvedValueOnce(commandResult(0, "present"))
        .mockResolvedValueOnce(commandResult(1)),
      readFile: vi
        .fn()
        .mockResolvedValue(
          new TextEncoder().encode('export const key = "dtn_secret_1234-abcd";'),
        ),
    } as unknown as DaytonaSandboxSession;
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      createPullRequestFromSandbox(
        {
          baseBranch: "main",
          baseSha: "a".repeat(40),
          body: "Pull request body",
          installationId: 123,
          organizationId: "org-1",
          repository: "acme/app",
          repositoryPath: "/home/daytona/workspace/repositories/acme/app",
          requestId: "12345678-1234-1234-1234-123456789012",
          title: "Fix: Broken route",
          workspaceBaseSha: "b".repeat(40),
        },
        session,
        {
          ...dependencies(),
          fetch: fetchMock,
        },
      ),
    ).rejects.toThrow("cannot contain a workspace secret placeholder");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows an existing placeholder fixture when the stored diff was scanned", async () => {
    const session = {
      execCommand: vi
        .fn()
        .mockResolvedValueOnce(commandResult(0, "src/config.ts\0"))
        .mockResolvedValueOnce(commandResult(0, "present"))
        .mockResolvedValueOnce(commandResult(1)),
      readFile: vi
        .fn()
        .mockResolvedValue(
          new TextEncoder().encode('export const fixture = "dtn_secret_1234-abcd";'),
        ),
    } as unknown as DaytonaSandboxSession;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ tree: { sha: "base-tree-sha" } }))
      .mockResolvedValueOnce(Response.json({ sha: "blob-sha" }))
      .mockResolvedValueOnce(Response.json({ sha: "tree-sha" }))
      .mockResolvedValueOnce(Response.json({ sha: "commit-sha" }))
      .mockResolvedValueOnce(Response.json({ ref: "refs/heads/fix" }))
      .mockResolvedValueOnce(
        Response.json({ number: 42, html_url: "https://github.com/acme/app/pull/42" }),
      );

    await expect(
      createPullRequestFromSandbox(
        {
          baseBranch: "main",
          baseSha: "a".repeat(40),
          body: "Pull request body",
          installationId: 123,
          organizationId: "org-1",
          repository: "acme/app",
          repositoryPath: "/home/daytona/workspace/repositories/acme/app",
          requestId: "12345678-1234-1234-1234-123456789012",
          scanChangedFileContents: false,
          title: "Fix: Broken route",
          workspaceBaseSha: "b".repeat(40),
        },
        session,
        {
          ...dependencies(),
          fetch: fetchMock,
        },
      ),
    ).resolves.toMatchObject({ number: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/app/git/trees",
      expect.objectContaining({
        body: expect.stringContaining('"base_tree":"base-tree-sha"'),
      }),
    );
  });

  it("rejects a pull request title containing a workspace secret placeholder", async () => {
    const session = {
      execCommand: vi
        .fn()
        .mockResolvedValueOnce(commandResult(0, "src/config.ts\0"))
        .mockResolvedValueOnce(commandResult(0, "present"))
        .mockResolvedValueOnce(commandResult(1)),
      readFile: vi.fn().mockResolvedValue(new TextEncoder().encode("safe\n")),
    } as unknown as DaytonaSandboxSession;
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      createPullRequestFromSandbox(
        {
          baseBranch: "main",
          baseSha: "a".repeat(40),
          body: "Pull request body",
          installationId: 123,
          organizationId: "org-1",
          repository: "acme/app",
          repositoryPath: "/home/daytona/workspace/repositories/acme/app",
          requestId: "12345678-1234-1234-1234-123456789012",
          title: "Fix dtn_secret_1234-abcd",
          workspaceBaseSha: "b".repeat(40),
        },
        session,
        {
          ...dependencies(),
          fetch: fetchMock,
        },
      ),
    ).rejects.toThrow("Pull request title cannot contain");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens the pull request with the chosen member's account when it can push", async () => {
    const execCommand = vi
      .fn()
      .mockResolvedValueOnce(commandResult(0, "src/route.ts\0"))
      .mockResolvedValueOnce(commandResult(0, "present"))
      .mockResolvedValueOnce(commandResult(1));
    const session = {
      execCommand,
      readFile: vi.fn().mockResolvedValue(new TextEncoder().encode("fixed\n")),
    } as unknown as DaytonaSandboxSession;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ permissions: { push: true } }))
      .mockResolvedValueOnce(Response.json({ tree: { sha: "base-tree-sha" } }))
      .mockResolvedValueOnce(Response.json({ sha: "blob-sha" }))
      .mockResolvedValueOnce(Response.json({ sha: "tree-sha" }))
      .mockResolvedValueOnce(Response.json({ sha: "commit-sha" }))
      .mockResolvedValueOnce(Response.json({ ref: "refs/heads/fix" }))
      .mockResolvedValueOnce(
        Response.json({ number: 42, html_url: "https://github.com/acme/app/pull/42" }),
      );
    const deps = { ...dependencies({ githubLogin: "octocat", token: "member-secret" }), fetch: fetchMock };
    deps.recordMemberBranch.mockImplementation(async () => {
      // The branch is recorded before GitHub can report the pull request.
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    await createPullRequestFromSandbox(
      {
        baseBranch: "main",
        baseSha: "a".repeat(40),
        body: "Pull request body",
        installationId: 123,
        organizationId: "org-1",
        repository: "acme/app",
        repositoryPath: "/home/daytona/workspace/repositories/acme/app",
        requestId: "12345678-1234-1234-1234-123456789012",
        title: "Fix: Broken route",
        workspaceBaseSha: "b".repeat(40),
      },
      session,
      deps,
    );

    expect(deps.memberToken).toHaveBeenCalledWith("org-1");
    expect(deps.createInstallationToken).not.toHaveBeenCalled();
    expect(deps.recordMemberBranch).toHaveBeenCalledWith({
      branch: "fix/fix-broken-route-12345678",
      organizationId: "org-1",
      repositoryFullName: "acme/app",
    });
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.headers).toMatchObject({ authorization: "Bearer member-secret" });
    }
    expect(JSON.stringify(execCommand.mock.calls)).not.toContain("member-secret");
  });
});

describe("pull request opener", () => {
  const target = { installationId: 123, organizationId: "org-1", repository: "acme/app" };

  it("uses the GitHub App without a chosen member", async () => {
    const deps = dependencies();

    await expect(pullRequestOpener(target, deps)).resolves.toEqual({ kind: "app", token: "github-secret" });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("uses the GitHub App when the member cannot push to the repository", async () => {
    const deps = dependencies({ githubLogin: "octocat", token: "member-secret" });
    deps.fetch.mockResolvedValueOnce(Response.json({ permissions: { push: false } }));

    await expect(pullRequestOpener(target, deps)).resolves.toEqual({ kind: "app", token: "github-secret" });
    expect(deps.fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/app",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer member-secret" }) }),
    );
    expect(deps.markMemberTokenRejected).not.toHaveBeenCalled();
  });

  it("uses the GitHub App when the member's repository access is unknown", async () => {
    const deps = dependencies({ githubLogin: "octocat", token: "member-secret" });
    deps.fetch.mockResolvedValueOnce(Response.json({ message: "Not Found" }, { status: 404 }));

    await expect(pullRequestOpener(target, deps)).resolves.toMatchObject({ kind: "app" });
    expect(deps.markMemberTokenRejected).not.toHaveBeenCalled();
  });

  it("stops using a token GitHub rejects", async () => {
    const deps = dependencies({ githubLogin: "octocat", token: "member-secret" });
    deps.fetch.mockResolvedValueOnce(Response.json({ message: "Bad credentials" }, { status: 401 }));

    await expect(pullRequestOpener(target, deps)).resolves.toMatchObject({ kind: "app" });
    expect(deps.markMemberTokenRejected).toHaveBeenCalledWith("org-1");
  });

  it("uses the GitHub App when the member's token cannot be loaded", async () => {
    const deps = dependencies();
    deps.memberToken.mockRejectedValueOnce(new Error("GitHub is unavailable"));

    await expect(pullRequestOpener(target, deps)).resolves.toMatchObject({ kind: "app" });
  });
});
