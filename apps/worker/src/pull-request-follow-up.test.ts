import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { changedFiles } from "./github-pull-request.js";
import {
  checkoutPullRequest,
  replyToPullRequestComment,
  updatePullRequest,
} from "./pull-request-follow-up.js";
import type { CheckedOutRepository } from "./repositories.js";

vi.mock("./github-pull-request.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./github-pull-request.js")>(),
  changedFiles: vi.fn(),
}));

const headSha = "c".repeat(40);
const pushedSha = "d".repeat(40);
const target = { installationId: 7, number: 42, repository: "acme/api" };

function checkout(overrides: Partial<CheckedOutRepository> = {}): CheckedOutRepository {
  return {
    branch: "fix/schema-reads-12345678",
    path: "/home/daytona/workspace/repositories/acme/api",
    repository: "acme/api",
    sha: headSha,
    workspaceBaseSha: "b".repeat(40),
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const pullRequest = {
  head: { ref: "fix/schema-reads-12345678", repo: { full_name: "acme/api" }, sha: headSha },
  html_url: "https://github.com/acme/api/pull/42",
  state: "open",
};

function session(baseline = "e".repeat(40)) {
  return {
    execCommand: vi.fn().mockResolvedValue(`Process exited with code 0\nOutput:\n${baseline}`),
    materializeEntry: vi.fn().mockResolvedValue(undefined),
  } as unknown as DaytonaSandboxSession & {
    execCommand: ReturnType<typeof vi.fn>;
    materializeEntry: ReturnType<typeof vi.fn>;
  };
}

function dependencies(fetchImpl: typeof fetch) {
  return { createInstallationToken: vi.fn().mockResolvedValue("token"), fetch: fetchImpl };
}

describe("pull request follow-up", () => {
  beforeEach(() => {
    vi.mocked(changedFiles).mockReset();
  });

  it("leaves a checkout that is already at the pull request's head", async () => {
    const checkoutAtRef = vi.fn();
    const repositories = [checkout()];

    const result = await checkoutPullRequest({
      checkoutAtRef,
      repositories,
      session: session(),
      target,
    }, dependencies(vi.fn().mockResolvedValue(json(pullRequest))));

    expect(result.replaced).toBe(false);
    expect(checkoutAtRef).not.toHaveBeenCalled();
  });

  it("replaces a stale checkout with the head and records every checkout", async () => {
    const replaced = checkout({ workspaceBaseSha: "f".repeat(40) });
    const other = { ...checkout(), path: "/other", repository: "acme/web" };
    const repositories = [checkout({ branch: "main", sha: "a".repeat(40) }), other];
    const sandbox = session();
    sandbox.execCommand.mockResolvedValue("Process exited with code 0\nOutput:\nnone");

    const result = await checkoutPullRequest({
      checkoutAtRef: vi.fn().mockResolvedValue(replaced),
      repositories,
      session: sandbox,
      target,
    }, dependencies(vi.fn().mockResolvedValue(json(pullRequest))));

    expect(result).toMatchObject({ checkout: replaced, replaced: true });
    expect(result).not.toHaveProperty("savedChanges");
    expect(repositories).toEqual([replaced, other]);
    expect(JSON.parse(sandbox.materializeEntry.mock.calls[0]![0].entry.content)).toEqual({
      repositories: [replaced, other],
    });
  });

  it("saves the old checkout's changes as a patch before replacing it", async () => {
    const sandbox = session();
    sandbox.execCommand.mockResolvedValue("Process exited with code 0\nOutput:\nsaved");
    const checkoutAtRef = vi.fn().mockResolvedValue(checkout());

    const result = await checkoutPullRequest({
      checkoutAtRef,
      repositories: [checkout({ branch: "main", sha: "a".repeat(40) })],
      session: sandbox,
      target,
    }, dependencies(vi.fn().mockResolvedValue(json(pullRequest))));

    expect(result.savedChanges).toMatch(/^\/home\/daytona\/workspace\/repositories\/acme\/api-unpushed-\d+\.patch$/u);
    const command = sandbox.execCommand.mock.calls[0]![0].cmd as string;
    expect(command).toContain(`git -C '/home/daytona/workspace/repositories/acme/api' diff --cached --binary ${"b".repeat(40)} > '${result.savedChanges}'`);
    expect(sandbox.execCommand.mock.invocationCallOrder[0]!).toBeLessThan(checkoutAtRef.mock.invocationCallOrder[0]!);
  });

  it("keeps the old checkout when its changes cannot be saved", async () => {
    const sandbox = session();
    sandbox.execCommand.mockResolvedValue("Process exited with code 1\nOutput:\nfatal");
    const checkoutAtRef = vi.fn();

    await expect(checkoutPullRequest({
      checkoutAtRef,
      repositories: [checkout({ branch: "main", sha: "a".repeat(40) })],
      session: sandbox,
      target,
    }, dependencies(vi.fn().mockResolvedValue(json(pullRequest))))).rejects.toThrow("Unable to save the changes");
    expect(checkoutAtRef).not.toHaveBeenCalled();
  });

  it("refuses a pull request from a fork", async () => {
    const fork = { ...pullRequest, head: { ...pullRequest.head, repo: { full_name: "someone/api" } } };

    await expect(checkoutPullRequest({
      checkoutAtRef: vi.fn(),
      repositories: [],
      session: session(),
      target,
    }, dependencies(vi.fn().mockResolvedValue(json(fork))))).rejects.toThrow("forked");
  });

  it("refuses to push from a checkout that is not the pull request", async () => {
    await expect(updatePullRequest({
      commitMessage: "Fix the test",
      repositories: [checkout({ branch: "main" })],
      session: session(),
      target,
    }, dependencies(vi.fn().mockResolvedValue(json(pullRequest))))).rejects.toThrow("Call checkout_pull_request first");
    expect(changedFiles).not.toHaveBeenCalled();
  });

  it("refuses to push over commits the checkout does not have", async () => {
    await expect(updatePullRequest({
      commitMessage: "Fix the test",
      repositories: [checkout({ sha: "a".repeat(40) })],
      session: session(),
      target,
    }, dependencies(vi.fn().mockResolvedValue(json(pullRequest))))).rejects.toThrow("has commits the checkout does not have");
    expect(changedFiles).not.toHaveBeenCalled();
  });

  it("pushes the changes onto the head without force and moves the baseline", async () => {
    vi.mocked(changedFiles).mockResolvedValue([
      { content: new TextEncoder().encode("fixed\n"), mode: "100644", path: "tests/test_schema.py" },
      { content: null, mode: "100644", path: "tests/old.py" },
    ]);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(pullRequest))
      .mockResolvedValueOnce(json({ tree: { sha: "tree-head" } }))
      .mockResolvedValueOnce(json({ sha: "blob-1" }))
      .mockResolvedValueOnce(json({ sha: "tree-new" }))
      .mockResolvedValueOnce(json({ sha: pushedSha }))
      .mockResolvedValueOnce(json(pullRequest))
      .mockResolvedValueOnce(json({ object: { sha: pushedSha } }));
    const repositories = [checkout()];
    const sandbox = session("e".repeat(40));

    const result = await updatePullRequest({
      commitMessage: "Fix the test",
      repositories,
      session: sandbox,
      target,
    }, dependencies(fetchImpl));

    expect(result).toEqual({
      changedFiles: ["tests/test_schema.py", "tests/old.py"],
      headSha: pushedSha,
      url: "https://github.com/acme/api/pull/42",
    });
    const calls = fetchImpl.mock.calls as Array<[string, RequestInit]>;
    expect(JSON.parse(calls[3]![1].body as string)).toEqual({
      base_tree: "tree-head",
      tree: [
        { mode: "100644", path: "tests/test_schema.py", sha: "blob-1", type: "blob" },
        { mode: "100644", path: "tests/old.py", sha: null, type: "blob" },
      ],
    });
    expect(JSON.parse(calls[4]![1].body as string)).toMatchObject({ parents: [headSha] });
    expect(calls[5]![0]).toBe("https://api.github.com/repos/acme/api/pulls/42");
    expect(calls[6]![0]).toBe("https://api.github.com/repos/acme/api/git/refs/heads/fix/schema-reads-12345678");
    expect(JSON.parse(calls[6]![1].body as string)).toEqual({ force: false, sha: pushedSha });
    expect(repositories[0]).toMatchObject({ sha: pushedSha, workspaceBaseSha: "e".repeat(40) });
  });

  it("does not move the branch when the pull request changed while the commit was prepared", async () => {
    vi.mocked(changedFiles).mockResolvedValue([
      { content: new TextEncoder().encode("fixed\n"), mode: "100644", path: "tests/test_schema.py" },
    ]);
    const reset = { ...pullRequest, head: { ...pullRequest.head, sha: "a".repeat(40) } };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(pullRequest))
      .mockResolvedValueOnce(json({ tree: { sha: "tree-head" } }))
      .mockResolvedValueOnce(json({ sha: "blob-1" }))
      .mockResolvedValueOnce(json({ sha: "tree-new" }))
      .mockResolvedValueOnce(json({ sha: pushedSha }))
      .mockResolvedValueOnce(json(reset));
    const repositories = [checkout()];

    await expect(updatePullRequest({
      commitMessage: "Fix the test",
      repositories,
      session: session(),
      target,
    }, dependencies(fetchImpl))).rejects.toThrow("changed while the commit was prepared");
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(repositories[0]).toEqual(checkout());
  });

  it("pushes nothing when the checkout has no changes", async () => {
    vi.mocked(changedFiles).mockResolvedValue([]);
    const fetchImpl = vi.fn().mockResolvedValue(json(pullRequest));

    await expect(updatePullRequest({
      commitMessage: "Fix the test",
      repositories: [checkout()],
      session: session(),
      target,
    }, dependencies(fetchImpl))).resolves.toEqual({
      changedFiles: [],
      headSha,
      url: "https://github.com/acme/api/pull/42",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  function threads(nodes: Array<{ first: number; id: string; isResolved?: boolean }>) {
    return json({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: nodes.map((node) => ({
                comments: { nodes: [{ databaseId: node.first }] },
                id: node.id,
                isResolved: node.isResolved ?? false,
              })),
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        },
      },
    });
  }
  const reviewComment = (id: number, inReplyTo?: number, number = 42) => json({
    id,
    ...(inReplyTo ? { in_reply_to_id: inReplyTo } : {}),
    pull_request_url: `https://api.github.com/repos/acme/api/pulls/${number}`,
  });

  it("replies in the thread that holds the comment and resolves it", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reviewComment(124, 123))
      .mockResolvedValueOnce(threads([{ first: 99, id: "thread-a" }, { first: 123, id: "thread-b" }]))
      .mockResolvedValueOnce(json({ data: { addPullRequestReviewThreadReply: { comment: { id: "c" } } } }))
      .mockResolvedValueOnce(json({ data: { resolveReviewThread: { thread: { id: "thread-b" } } } }));

    await expect(replyToPullRequestComment({
      body: "Fixed: the test now checks one catalog reference.",
      commentId: 124,
      resolve: true,
      target,
    }, dependencies(fetchImpl))).resolves.toEqual({ resolved: true });

    const calls = fetchImpl.mock.calls as Array<[string, RequestInit]>;
    expect(calls[0]![0]).toBe("https://api.github.com/repos/acme/api/pulls/comments/124");
    const bodies = calls.slice(1).map(([, init]) => JSON.parse(init.body as string) as { variables: Record<string, unknown> });
    expect(bodies[1]!.variables).toEqual({
      body: "Fixed: the test now checks one catalog reference.",
      threadId: "thread-b",
    });
    expect(bodies[2]!.variables).toEqual({ threadId: "thread-b" });
  });

  it("reports a failed resolve without failing the posted reply", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reviewComment(123))
      .mockResolvedValueOnce(threads([{ first: 123, id: "thread-b" }]))
      .mockResolvedValueOnce(json({ data: { addPullRequestReviewThreadReply: { comment: { id: "c" } } } }))
      .mockResolvedValueOnce(json({ errors: [{ message: "Resource not accessible by integration" }] }));

    await expect(replyToPullRequestComment({
      body: "Done.",
      commentId: 123,
      resolve: true,
      target,
    }, dependencies(fetchImpl))).resolves.toEqual({
      resolveError: "Resource not accessible by integration",
      resolved: false,
    });
  });

  it("refuses a comment that is not on the pull request", async () => {
    const otherPullRequest = vi.fn().mockResolvedValueOnce(reviewComment(5, undefined, 7));
    const missing = vi.fn().mockResolvedValueOnce(json({ message: "Not Found" }, 404));

    for (const fetchImpl of [otherPullRequest, missing]) {
      await expect(replyToPullRequestComment({
        body: "Done.",
        commentId: 5,
        resolve: false,
        target,
      }, dependencies(fetchImpl))).rejects.toThrow("is not a review comment on pull request #42");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});
