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

describe("protected files in agent pull requests", () => {
  const input = {
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
  };

  function sessionWith(listed: string[]) {
    const execCommand = vi.fn().mockResolvedValueOnce(commandResult(0, listed.map((path) => `${path}\0`).join("")));
    listed.forEach(() => {
      execCommand.mockResolvedValueOnce(commandResult(0, "present")).mockResolvedValueOnce(commandResult(1));
    });
    return {
      execCommand,
      session: {
        execCommand,
        readFile: vi.fn().mockResolvedValue(new TextEncoder().encode("changed\n")),
      } as unknown as DaytonaSandboxSession,
    };
  }

  function publishedFetch() {
    return vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ tree: { sha: "base-tree-sha" } }))
      .mockResolvedValueOnce(Response.json({ sha: "blob-sha" }))
      .mockResolvedValueOnce(Response.json({ sha: "blob-sha-2" }))
      .mockResolvedValueOnce(Response.json({ sha: "tree-sha" }))
      .mockResolvedValueOnce(Response.json({ sha: "commit-sha" }))
      .mockResolvedValueOnce(Response.json({ ref: "refs/heads/fix" }))
      .mockResolvedValueOnce(Response.json({ number: 42, html_url: "https://github.com/acme/app/pull/42" }));
  }

  it("refuses CI, dependency, and agent instruction changes before publishing anything", async () => {
    const { execCommand, session } = sessionWith([
      "src/route.ts",
      ".github/workflows/ci.yml",
      "package.json",
      "AGENTS.md",
    ]);
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      createPullRequestFromSandbox(input, session, { ...dependencies(), fetch: fetchMock }),
    ).rejects.toThrow(
      "Agents cannot change these files: .github/workflows/ci.yml (CI configuration), package.json (dependencies), AGENTS.md (agent instructions).",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    // Refused before any file is read.
    expect(execCommand).toHaveBeenCalledTimes(1);
  });

  it("lists renamed files under both names so a rename cannot hide a protected file", async () => {
    const { execCommand, session } = sessionWith(["src/route.ts"]);
    await createPullRequestFromSandbox(input, session, {
      ...dependencies(),
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ tree: { sha: "base-tree-sha" } }))
        .mockResolvedValueOnce(Response.json({ sha: "blob-sha" }))
        .mockResolvedValueOnce(Response.json({ sha: "tree-sha" }))
        .mockResolvedValueOnce(Response.json({ sha: "commit-sha" }))
        .mockResolvedValueOnce(Response.json({ ref: "refs/heads/fix" }))
        .mockResolvedValueOnce(Response.json({ number: 42, html_url: "https://github.com/acme/app/pull/42" })),
    });
    expect(String(execCommand.mock.calls[0]?.[0]?.cmd)).toContain("git diff --no-renames --name-only");
  });

  it("publishes dependency changes when the automation allows them", async () => {
    const { session } = sessionWith(["src/route.ts", "package.json"]);
    await expect(
      createPullRequestFromSandbox(
        { ...input, allowDependencyChanges: true },
        session,
        { ...dependencies(), fetch: publishedFetch() },
      ),
    ).resolves.toMatchObject({ changedFiles: ["src/route.ts", "package.json"] });
  });

  it("never publishes CI changes, even when dependency changes are allowed", async () => {
    const { session } = sessionWith([".github/actions/setup/action.yml"]);
    await expect(
      createPullRequestFromSandbox(
        { ...input, allowDependencyChanges: true },
        session,
        { ...dependencies(), fetch: vi.fn<typeof fetch>() },
      ),
    ).rejects.toThrow(".github/actions/setup/action.yml (CI configuration)");
  });

  it("notes in the body when an outside event started the run", async () => {
    const { session } = sessionWith(["src/route.ts", "src/other.ts"]);
    const fetchMock = publishedFetch();
    await createPullRequestFromSandbox(
      { ...input, untrustedTrigger: true },
      session,
      { ...dependencies(), fetch: fetchMock },
    );
    const pullRequestCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/pulls"));
    const body = JSON.parse(String(pullRequestCall?.[1]?.body)) as { body: string };
    expect(body.body.startsWith("Pull request body")).toBe(true);
    expect(body.body).toContain("written from an event sent from outside this workspace");
    expect(body.body).toContain("review it as untrusted input");
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
