import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchPullRequestDetail,
  fetchPullRequestStates,
  parsePullRequestUrl,
  pullRequestConversation,
} from "./github.js";

vi.mock("../../../../packages/core/src/integrations/github.js", () => ({
  createGitHubInstallationToken: vi.fn().mockResolvedValue("installation-token"),
  githubAppHeaders: (token: string) => ({ authorization: `Bearer ${token}` }),
}));

const user = { avatar_url: "https://avatars.githubusercontent.com/u/1", login: "octocat" };

function json(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers }, status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parsePullRequestUrl", () => {
  it("reads the owner, repository, and number", () => {
    expect(parsePullRequestUrl("https://github.com/acme/api.v2/pull/42")).toEqual({ number: 42, owner: "acme", repo: "api.v2" });
  });

  it("rejects other links", () => {
    expect(parsePullRequestUrl("https://github.com/acme/api/issues/42")).toBeNull();
    expect(parsePullRequestUrl("https://example.com/acme/api/pull/42")).toBeNull();
    expect(parsePullRequestUrl("https://github.com/acme/api/pull/0")).toBeNull();
  });
});

describe("pullRequestConversation", () => {
  const author = { avatarUrl: null, login: "octocat" };

  it("orders comments and reviews and attaches inline comments to their review", () => {
    const conversation = pullRequestConversation({
      issueComments: [
        { body: "Second", created_at: "2026-10-02T00:00:00Z", html_url: "https://github.com/c/2", id: 2, user: author },
        { body: "First", created_at: "2026-10-01T00:00:00Z", html_url: "https://github.com/c/1", id: 1, user: author },
      ],
      reviewComments: [
        { body: "Rename this", created_at: "2026-10-01T12:00:00Z", html_url: "https://github.com/r/5", id: 5, line: 10, path: "src/a.ts", pull_request_review_id: 9 },
        { body: "Old line", created_at: "2026-10-01T12:00:00Z", html_url: "https://github.com/r/6", id: 6, line: null, original_line: 4, path: "src/b.ts", pull_request_review_id: 9 },
      ],
      reviews: [
        { body: "", html_url: "https://github.com/v/9", id: 9, state: "CHANGES_REQUESTED", submitted_at: "2026-10-01T12:00:00Z", user: author },
        // A review with nothing to show is left out.
        { body: "", html_url: "https://github.com/v/10", id: 10, state: "COMMENTED", submitted_at: "2026-10-01T13:00:00Z", user: author },
        { body: "Draft", html_url: "https://github.com/v/11", id: 11, state: "PENDING", submitted_at: null, user: author },
      ],
    });

    expect(conversation.map((entry) => `${entry.kind}:${entry.id}`)).toEqual(["comment:1", "review:9", "comment:2"]);
    const review = conversation[1];
    expect(review).toMatchObject({ kind: "review", state: "changes_requested" });
    expect(review?.kind === "review" ? review.comments.map((comment) => `${comment.path}:${comment.line}`) : []).toEqual(["src/a.ts:10", "src/b.ts:4"]);
  });
});

describe("fetchPullRequestDetail", () => {
  it("reads the pull request, its conversation, and every page of commits", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/pulls/42")) {
        return json({
          additions: 12, base: { ref: "main" }, body: "Fixes the login.", changed_files: 2, closed_at: null,
          created_at: "2026-10-01T00:00:00Z", deletions: 3, draft: false, head: { ref: "superlog/fix-login" },
          html_url: "https://github.com/acme/api/pull/42", merged_at: null, state: "open", title: "Fix login", user,
        });
      }
      if (url.endsWith("/pulls/42/commits?per_page=100")) {
        return json(
          [{ author: user, commit: { author: { date: "2026-10-01T00:00:00Z", name: "Octo" }, message: "First" }, html_url: "https://github.com/c/a", sha: "a".repeat(40) }],
          { link: '<https://api.github.com/repositories/1/pulls/42/commits?per_page=100&page=2>; rel="next"' },
        );
      }
      if (url.endsWith("/pulls/42/commits?per_page=100&page=2")) {
        return json([{ author: null, commit: { author: { date: null, name: "Bot" }, message: "Second\n\nBody" }, html_url: "https://github.com/c/b", sha: "b".repeat(40) }]);
      }
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const detail = await fetchPullRequestDetail(7, { number: 42, owner: "acme", repo: "api" });

    expect(detail).toMatchObject({ baseBranch: "main", body: "Fixes the login.", headBranch: "superlog/fix-login", state: "open", title: "Fix login" });
    expect(detail.commits.map((commit) => commit.sha[0])).toEqual(["a", "b"]);
    expect(detail.commits[1]).toMatchObject({ author: null, authorName: "Bot", committedAt: null });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
      "https://api.github.com/repos/acme/api/issues/42/comments?per_page=100",
      "https://api.github.com/repos/acme/api/pulls/42/reviews?per_page=100",
      "https://api.github.com/repos/acme/api/pulls/42/comments?per_page=100",
    ]));
  });

  it("does not follow a next page outside the GitHub API", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/pulls/1")
      ? json({ base: { ref: "main" }, created_at: "2026-10-01T00:00:00Z", head: { ref: "fix" }, html_url: "https://github.com/acme/api/pull/1", state: "closed", title: "Fix", merged_at: "2026-10-02T00:00:00Z" })
      : json([], { link: '<https://attacker.example/next>; rel="next"' }));
    vi.stubGlobal("fetch", fetchMock);

    const detail = await fetchPullRequestDetail(7, { number: 1, owner: "acme", repo: "api" });

    expect(detail.state).toBe("merged");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

describe("fetchPullRequestStates", () => {
  it("reads every state in one request and leaves missing pull requests unknown", async () => {
    const fetchMock = vi.fn(async () => json({
      data: {
        pr0: { pullRequest: { isDraft: true, state: "OPEN" } },
        pr1: { pullRequest: { isDraft: false, state: "MERGED" } },
        pr2: null,
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const states = await fetchPullRequestStates(7, [
      { number: 1, owner: "acme", repo: "api" },
      { number: 2, owner: "acme", repo: "api" },
      { number: 3, owner: "acme", repo: "gone" },
    ]);

    expect(states).toEqual(["draft", "merged", null]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { variables: Record<string, unknown> };
    expect(body.variables).toMatchObject({ name2: "gone", number2: 3, owner0: "acme" });
  });
});
