import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import {
  assertPullRequestReviewStateCurrent,
  listUnresolvedBotReviewThreads,
  publishPullRequestReviewChanges,
  replyToAndResolveReviewThreads,
} from "./github-pull-request-review.js";

const headSha = "a".repeat(40);

function commandResult(exitCode: number, output = "") {
  return `Process exited with code ${exitCode}\nOutput:\n${output}`;
}

function graphqlResponse(data: unknown) {
  return Response.json({ data });
}

describe("GitHub pull request review follow-up", () => {
  it("lists only unresolved, current bot-authored threads", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      graphqlResponse({
        repository: {
          pullRequest: {
            headRefName: "fix/broken-route-12345678",
            headRefOid: headSha,
            headRepository: { nameWithOwner: "acme/app" },
            reviewThreads: {
              nodes: [
                {
                  id: "thread-bot",
                  isOutdated: false,
                  isResolved: false,
                  comments: {
                    nodes: [
                      {
                        author: { login: "reviewer[bot]", __typename: "Bot" },
                        body: "Handle the null case.",
                        id: "comment-1",
                        line: 12,
                        originalLine: 12,
                        path: "src/route.ts",
                        url: "https://github.com/acme/app/pull/42#discussion_r1",
                      },
                    ],
                  },
                },
                {
                  id: "thread-human",
                  isOutdated: false,
                  isResolved: false,
                  comments: {
                    nodes: [
                      {
                        author: { login: "ash", __typename: "User" },
                        body: "Rename this.",
                        id: "comment-2",
                        line: 4,
                        originalLine: 4,
                        path: "src/route.ts",
                        url: "https://github.com/acme/app/pull/42#discussion_r2",
                      },
                    ],
                  },
                },
                {
                  id: "thread-outdated",
                  isOutdated: true,
                  isResolved: false,
                  comments: { nodes: [] },
                },
              ],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        },
      }),
    );

    await expect(
      listUnresolvedBotReviewThreads(
        {
          installationId: 123,
          pullRequestNumber: 42,
          repository: "acme/app",
        },
        {
          createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
          fetch: fetchMock,
        },
      ),
    ).resolves.toEqual({
      branch: "fix/broken-route-12345678",
      headSha,
      threads: [
        {
          author: "reviewer[bot]",
          body: "Handle the null case.",
          id: "thread-bot",
          line: 12,
          path: "src/route.ts",
          url: "https://github.com/acme/app/pull/42#discussion_r1",
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/graphql",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer github-secret" }),
      }),
    );
  });

  it("rejects a forked pull request head", async () => {
    await expect(
      listUnresolvedBotReviewThreads(
        {
          installationId: 123,
          pullRequestNumber: 42,
          repository: "acme/app",
        },
        {
          createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
          fetch: vi.fn<typeof fetch>().mockResolvedValue(
            graphqlResponse({
              repository: {
                pullRequest: {
                  headRefName: "fix",
                  headRefOid: headSha,
                  headRepository: { nameWithOwner: "someone/app" },
                  reviewThreads: {
                    nodes: [],
                    pageInfo: { endCursor: null, hasNextPage: false },
                  },
                },
              },
            }),
          ),
        },
      ),
    ).rejects.toThrow("forked repositories");
  });

  it("loads bot review threads from every page", async () => {
    const thread = (id: string, path: string) => ({
      id,
      isOutdated: false,
      isResolved: false,
      comments: {
        nodes: [
          {
            author: { login: "reviewer[bot]", __typename: "Bot" },
            body: `Review ${path}`,
            id: `comment-${id}`,
            line: 5,
            originalLine: 5,
            path,
            url: `https://github.com/acme/app/pull/42#discussion_${id}`,
          },
        ],
      },
    });
    const page = (
      nodes: ReturnType<typeof thread>[],
      pageInfo: { endCursor: string | null; hasNextPage: boolean },
    ) =>
      graphqlResponse({
        repository: {
          pullRequest: {
            headRefName: "fix/review",
            headRefOid: headSha,
            headRepository: { nameWithOwner: "acme/app" },
            reviewThreads: { nodes, pageInfo },
          },
        },
      });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        page([thread("thread-1", "src/one.ts")], {
          endCursor: "cursor-1",
          hasNextPage: true,
        }),
      )
      .mockResolvedValueOnce(
        page([thread("thread-2", "src/two.ts")], {
          endCursor: null,
          hasNextPage: false,
        }),
      );

    const result = await listUnresolvedBotReviewThreads(
      {
        installationId: 123,
        pullRequestNumber: 42,
        repository: "acme/app",
      },
      {
        createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
        fetch: fetchMock,
      },
    );

    expect(result.threads.map((item) => item.id)).toEqual([
      "thread-1",
      "thread-2",
    ]);
    const secondRequest = JSON.parse(
      (fetchMock.mock.calls[1]?.[1]?.body as string) ?? "{}",
    );
    expect(secondRequest.variables.after).toBe("cursor-1");
  });

  it("fast-forwards the existing PR branch with sandbox changes", async () => {
    const session = {
      execCommand: vi
        .fn()
        .mockResolvedValueOnce(commandResult(0, "src/route.ts\0"))
        .mockResolvedValueOnce(commandResult(0, "present"))
        .mockResolvedValueOnce(commandResult(1)),
      readFile: vi.fn().mockResolvedValue(new TextEncoder().encode("fixed\n")),
    } as unknown as DaytonaSandboxSession;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ tree: { sha: "head-tree-sha" } }))
      .mockResolvedValueOnce(Response.json({ sha: "blob-sha" }))
      .mockResolvedValueOnce(Response.json({ sha: "tree-sha" }))
      .mockResolvedValueOnce(Response.json({ sha: "commit-sha" }))
      .mockResolvedValueOnce(Response.json({ ref: "refs/heads/fix/review" }));

    await expect(
      publishPullRequestReviewChanges(
        {
          branch: "fix/review",
          commitMessage: "Address review feedback",
          headSha,
          installationId: 123,
          repository: "acme/app",
          repositoryPath: "/home/daytona/workspace/repositories/acme/app",
          workspaceBaseSha: "b".repeat(40),
        },
        session,
        {
          createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
          fetch: fetchMock,
        },
      ),
    ).resolves.toEqual({
      changedFiles: ["src/route.ts"],
      headSha: "commit-sha",
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://api.github.com/repos/acme/app/git/refs/heads/fix/review",
      expect.objectContaining({
        body: JSON.stringify({ force: false, sha: "commit-sha" }),
        method: "PATCH",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.github.com/repos/acme/app/git/trees",
      expect.objectContaining({
        body: expect.stringContaining('"base_tree":"head-tree-sha"'),
      }),
    );
  });

  it("can respond without publishing a commit", async () => {
    const session = {
      execCommand: vi.fn().mockResolvedValue(commandResult(0)),
    } as unknown as DaytonaSandboxSession;
    const createInstallationToken = vi.fn();

    await expect(
      publishPullRequestReviewChanges(
        {
          branch: "fix/review",
          commitMessage: "Address review feedback",
          headSha,
          installationId: 123,
          repository: "acme/app",
          repositoryPath: "/home/daytona/workspace/repositories/acme/app",
          workspaceBaseSha: "b".repeat(40),
        },
        session,
        { createInstallationToken, fetch: vi.fn() },
      ),
    ).resolves.toEqual({ changedFiles: [], headSha });
    expect(createInstallationToken).not.toHaveBeenCalled();
  });

  it("replies before resolving each supplied thread", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        graphqlResponse({
          node: { comments: { nodes: [] }, isResolved: false },
        }),
      )
      .mockResolvedValueOnce(
        graphqlResponse({
          addPullRequestReviewThreadReply: { comment: { id: "reply" } },
        }),
      )
      .mockResolvedValueOnce(
        graphqlResponse({
          resolveReviewThread: { thread: { id: "thread-1", isResolved: true } },
        }),
      );

    await replyToAndResolveReviewThreads(
      {
        installationId: 123,
        responses: [{ body: "Handled in the follow-up commit.", threadId: "thread-1" }],
      },
      {
        createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
        fetch: fetchMock,
      },
    );

    const firstBody = JSON.parse(
      (fetchMock.mock.calls[0]?.[1]?.body as string) ?? "{}",
    );
    const secondBody = JSON.parse(
      (fetchMock.mock.calls[1]?.[1]?.body as string) ?? "{}",
    );
    const thirdBody = JSON.parse(
      (fetchMock.mock.calls[2]?.[1]?.body as string) ?? "{}",
    );
    expect(firstBody.query).toContain("ResponderReviewThreadState");
    expect(secondBody.query).toContain("addPullRequestReviewThreadReply");
    expect(secondBody.variables.body).toContain(
      "<!-- responder-review-thread:thread-1 -->",
    );
    expect(thirdBody.query).toContain("resolveReviewThread");
  });

  it("resumes resolution without duplicating a reply after a lost response", async () => {
    const marker = "<!-- responder-review-thread:thread-1 -->";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        graphqlResponse({
          node: { comments: { nodes: [] }, isResolved: false },
        }),
      )
      .mockRejectedValueOnce(new Error("connection lost after write"))
      .mockResolvedValueOnce(
        graphqlResponse({
          node: {
            comments: { nodes: [{ body: `Handled.\n\n${marker}` }] },
            isResolved: false,
          },
        }),
      )
      .mockResolvedValueOnce(
        graphqlResponse({
          resolveReviewThread: { thread: { id: "thread-1", isResolved: true } },
        }),
      );

    await expect(
      replyToAndResolveReviewThreads(
        {
          installationId: 123,
          responses: [{ body: "Handled.", threadId: "thread-1" }],
        },
        {
          createInstallationToken: vi.fn().mockResolvedValue("github-secret"),
          fetch: fetchMock,
        },
      ),
    ).resolves.toBeUndefined();
    const operations = fetchMock.mock.calls.map((call) =>
      JSON.parse((call[1]?.body as string) ?? "{}").query,
    );
    expect(
      operations.filter((query) => query.includes("addPullRequestReviewThreadReply")),
    ).toHaveLength(1);
    expect(operations.at(-1)).toContain("resolveReviewThread");
  });

  it("rejects review publication when the PR head changed", () => {
    const expected = {
      branch: "fix/review",
      headSha,
      threads: [
        {
          author: "reviewer[bot]",
          body: "Handle this.",
          id: "thread-1",
          line: 5,
          path: "src/app.ts",
          url: "https://github.com/acme/app/pull/42#discussion_thread-1",
        },
      ],
    };

    expect(() =>
      assertPullRequestReviewStateCurrent(
        expected,
        { ...expected, headSha: "c".repeat(40) },
        new Set(["thread-1"]),
      ),
    ).toThrow("head changed");
  });
});
