import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchPullRequestDetail,
  fetchPullRequestFiles,
  fetchPullRequestStates,
  parsePullRequestUrl,
  pullRequestConversation,
} from "./github.js";

const tokenMock = vi.hoisted(() => vi.fn().mockResolvedValue("installation-token"));

vi.mock("../../../../packages/core/src/integrations/github.js", () => ({
  createGitHubInstallationToken: tokenMock,
  githubAppHeaders: (token: string) => ({ authorization: `Bearer ${token}` }),
}));

const user = { avatar_url: "https://avatars.githubusercontent.com/u/1", login: "octocat" };

function json(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers }, status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  tokenMock.mockClear();
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

  it("bounds the installation token request with a timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).endsWith("/pulls/1")
      ? json({ base: { ref: "main" }, created_at: "2026-10-01T00:00:00Z", head: { ref: "fix" }, html_url: "https://github.com/acme/api/pull/1", state: "open", title: "Fix" })
      : json([])));

    await fetchPullRequestDetail(7, { number: 1, owner: "acme", repo: "api" });

    expect(tokenMock).toHaveBeenCalledWith(7, expect.any(AbortSignal));
  });

  it("reports a timed-out GitHub request with a gateway timeout status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("The operation timed out.", "TimeoutError"); }));

    await expect(fetchPullRequestDetail(7, { number: 1, owner: "acme", repo: "api" })).rejects.toMatchObject({ name: "GitHubPullRequestError", status: 504 });
  });

  it("reports a failed installation token with a status", async () => {
    tokenMock.mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));
    await expect(fetchPullRequestFiles(7, { number: 1, owner: "acme", repo: "api" })).rejects.toMatchObject({ status: 504 });

    tokenMock.mockRejectedValueOnce(new Error("Unable to create GitHub installation token"));
    await expect(fetchPullRequestFiles(7, { number: 1, owner: "acme", repo: "api" })).rejects.toMatchObject({ status: 502 });
  });

  it("says when the conversation has more pages than it reads", async () => {
    let page = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/pulls/1")) {
        return json({ base: { ref: "main" }, created_at: "2026-10-01T00:00:00Z", head: { ref: "fix" }, html_url: "https://github.com/acme/api/pull/1", state: "open", title: "Fix" });
      }
      if (url.includes("/issues/1/comments")) {
        page += 1;
        return json([], { link: `<https://api.github.com/repositories/1/issues/1/comments?per_page=100&page=${page + 1}>; rel="next"` });
      }
      return json([]);
    }));

    const detail = await fetchPullRequestDetail(7, { number: 1, owner: "acme", repo: "api" });

    expect(detail.conversationTruncated).toBe(true);
  });
});

describe("fetchPullRequestFiles", () => {
  it("reads every changed file and keeps a missing patch as null", async () => {
    const fetchMock = vi.fn(async () => json([
      { additions: 2, deletions: 1, filename: "src/a.ts", patch: "@@ -1 +1,2 @@\n-a\n+b\n+c", status: "modified" },
      { additions: 0, deletions: 0, filename: "logo.png", status: "added" },
      { additions: 0, deletions: 0, filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed" },
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const files = await fetchPullRequestFiles(7, { number: 42, owner: "acme", repo: "api" });

    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toBe("https://api.github.com/repos/acme/api/pulls/42/files?per_page=100");
    expect(files).toEqual([
      { additions: 2, deletions: 1, filename: "src/a.ts", patch: "@@ -1 +1,2 @@\n-a\n+b\n+c", previousFilename: null, status: "modified" },
      { additions: 0, deletions: 0, filename: "logo.png", patch: null, previousFilename: null, status: "added" },
      { additions: 0, deletions: 0, filename: "src/new.ts", patch: null, previousFilename: "src/old.ts", status: "renamed" },
    ]);
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

  it("fails when GitHub returns GraphQL errors and no data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: null, errors: [{ message: "Bad credentials" }] })));

    await expect(fetchPullRequestStates(7, [{ number: 1, owner: "acme", repo: "api" }])).rejects.toThrow("GitHub GraphQL returned no data");
  });

  it("logs GraphQL errors that come with partial data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      data: { pr0: { pullRequest: { isDraft: false, state: "OPEN" } }, pr1: null },
      errors: [{ type: "NOT_FOUND" }],
    })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const states = await fetchPullRequestStates(7, [{ number: 1, owner: "acme", repo: "api" }, { number: 2, owner: "acme", repo: "gone" }]);

    expect(states).toEqual(["open", null]);
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ errors: 1, event: "pull_request_states_partial", installationId: 7 }));
  });
});
