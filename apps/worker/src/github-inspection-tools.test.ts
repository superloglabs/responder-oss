import type { GitHubInstallationTokenOptions } from "@responder/core/integrations/github";
import { describe, expect, it, type Mock, vi } from "vitest";
import { createGitHubInspectionTools } from "./github-inspection-tools.js";

type InstallationTokenMock = Mock<
  (
    installationId: number,
    options?: GitHubInstallationTokenOptions,
  ) => Promise<string>
>;
type FetchMock = Mock<typeof globalThis.fetch>;

const repository = {
  defaultBranch: "main",
  fullName: "acme/service",
  installationId: 42,
  private: true,
};

const pullRequest = {
  additions: 12,
  base: { ref: "main", sha: "b".repeat(40) },
  body: "Fixes the deploy race.",
  changed_files: 2,
  closed_at: "2026-09-18T10:30:00Z",
  comments: 1,
  commits: 1,
  created_at: "2026-09-18T09:00:00Z",
  deletions: 3,
  draft: false,
  head: { ref: "ash/fix-deploy", sha: "a".repeat(40) },
  html_url: "https://github.com/acme/service/pull/17",
  merge_commit_sha: "c".repeat(40),
  merged_at: "2026-09-18T10:30:00Z",
  number: 17,
  review_comments: 1,
  state: "closed",
  title: "Fix deploy race",
  updated_at: "2026-09-18T10:30:00Z",
  user: { login: "ash" },
};

const workflowRun = {
  conclusion: "failure",
  created_at: "2026-09-18T11:00:00Z",
  display_title: "Deploy production",
  event: "push",
  head_branch: "main",
  head_sha: "a".repeat(40),
  html_url: "https://github.com/acme/service/actions/runs/1001",
  id: 1001,
  name: "Deploy production",
  run_attempt: 1,
  status: "completed",
  updated_at: "2026-09-18T11:05:00Z",
  workflow_id: 99,
};

const checkRun = {
  app: { name: "GitHub Actions", slug: "github-actions" },
  completed_at: "2026-09-18T11:05:00Z",
  conclusion: "failure",
  details_url: "https://github.com/acme/service/actions/runs/1001",
  head_sha: "a".repeat(40),
  html_url: "https://github.com/acme/service/runs/2002",
  id: 2002,
  name: "test",
  output: {
    annotations_count: 1,
    summary: "Tests failed",
    text: "One test failed",
    title: "Failure",
  },
  started_at: "2026-09-18T11:00:00Z",
  status: "completed",
};

function toolByName(
  name: string,
  options: {
    createInstallationToken?: InstallationTokenMock;
    fetch?: FetchMock;
  } = {},
) {
  const createInstallationToken =
    options.createInstallationToken ??
    vi.fn<InstallationTokenMock>().mockResolvedValue(
      "read-only-installation-token",
    );
  const fetch = options.fetch ?? vi.fn<typeof globalThis.fetch>();
  const tools = createGitHubInspectionTools([repository], {
    createInstallationToken,
    fetch: fetch as typeof globalThis.fetch,
    now: () => 1_000,
  });
  return {
    createInstallationToken,
    fetch,
    tool: tools.find((candidate) => candidate.name === name)!,
    tools,
  };
}

describe("GitHub inspection tools", () => {
  it("does not expose GitHub tools without attached repositories", () => {
    expect(createGitHubInspectionTools([])).toEqual([]);
  });

  it("exposes only bounded read operations", () => {
    const { tools } = toolByName("github_list_pull_requests");
    expect(tools.map(({ name }) => name)).toEqual([
      "github_list_pull_requests",
      "github_get_pull_request",
      "github_list_workflow_runs",
      "github_get_workflow_run",
      "github_list_check_runs",
      "github_get_check_run",
    ]);
  });

  it("lists pull requests with a repository-scoped read token", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json([pullRequest]));
    const { createInstallationToken, tool } = toolByName(
      "github_list_pull_requests",
      { fetch },
    );

    await expect(
      tool.invoke(
        undefined as never,
        JSON.stringify({ repository: "acme/service" }),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        author: "ash",
        mergedAt: "2026-09-18T10:30:00Z",
        number: 17,
        title: "Fix deploy race",
      }),
    ]);
    expect(createInstallationToken).toHaveBeenCalledWith(42, {
      permissions: {
        actions: "read",
        checks: "read",
        contents: "read",
        metadata: "read",
        pull_requests: "read",
      },
      repositories: ["service"],
    });
    const [requestedUrl, request] = fetch.mock.calls[0]!;
    const url = new URL(String(requestedUrl));
    expect(url.origin).toBe("https://api.github.com");
    expect(url.pathname).toBe("/repos/acme/service/pulls");
    expect(url.searchParams.get("state")).toBe("all");
    expect(url.searchParams.get("per_page")).toBe("30");
    expect(request).toMatchObject({ method: "GET" });
  });

  it("rejects repositories outside the Agent version", async () => {
    const { createInstallationToken, fetch, tool } = toolByName(
      "github_list_workflow_runs",
    );

    await expect(
      tool.invoke(
        undefined as never,
        JSON.stringify({ repository: "other/private" }),
      ),
    ).resolves.toContain("Repository is not attached");
    expect(createInstallationToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns pull request reviews and comments without unbounded fields", async () => {
    const fetch = vi.fn().mockImplementation((request: URL | RequestInfo) => {
      const path = new URL(String(request)).pathname;
      if (path.endsWith("/reviews")) {
        return Promise.resolve(Response.json([{
          body: "Looks good",
          html_url: "https://github.com/acme/service/pull/17#review-1",
          id: 1,
          state: "APPROVED",
          submitted_at: "2026-09-18T10:00:00Z",
          user: { login: "reviewer" },
        }]));
      }
      if (path.endsWith("/pulls/17/comments")) {
        return Promise.resolve(Response.json([{
          body: "Please keep this guard.",
          created_at: "2026-09-18T09:30:00Z",
          diff_hunk: "@@ -1 +1 @@",
          html_url: "https://github.com/acme/service/pull/17#discussion-1",
          id: 3,
          line: 12,
          original_line: 12,
          path: "src/deploy.ts",
          updated_at: "2026-09-18T09:30:00Z",
          user: { login: "reviewer" },
        }]));
      }
      if (path.endsWith("/issues/17/comments")) {
        return Promise.resolve(Response.json([{
          body: "Deployed successfully.",
          created_at: "2026-09-18T10:35:00Z",
          html_url: "https://github.com/acme/service/pull/17#issuecomment-1",
          id: 2,
          updated_at: "2026-09-18T10:35:00Z",
          user: { login: "ash" },
        }]));
      }
      return Promise.resolve(Response.json(pullRequest));
    });
    const { tool } = toolByName("github_get_pull_request", { fetch });

    await expect(
      tool.invoke(
        undefined as never,
        JSON.stringify({
          discussionLimit: 20,
          pullRequestNumber: 17,
          repository: "acme/service",
        }),
      ),
    ).resolves.toMatchObject({
      comments: [{ author: "ash", body: "Deployed successfully." }],
      reviewComments: [{ path: "src/deploy.ts", line: 12 }],
      reviews: [{ author: "reviewer", state: "APPROVED" }],
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("reads workflow runs with bounded job and step history", async () => {
    const fetch = vi.fn().mockImplementation((request: URL | RequestInfo) => {
      const path = new URL(String(request)).pathname;
      if (path.endsWith("/jobs")) {
        return Promise.resolve(Response.json({
          jobs: [{
            completed_at: "2026-09-18T11:05:00Z",
            conclusion: "failure",
            html_url: "https://github.com/acme/service/actions/runs/1001/job/7",
            id: 7,
            name: "test",
            runner_name: "GitHub Actions 1",
            started_at: "2026-09-18T11:01:00Z",
            status: "completed",
            steps: [{
              completed_at: "2026-09-18T11:04:00Z",
              conclusion: "failure",
              name: "Run tests",
              number: 3,
              started_at: "2026-09-18T11:02:00Z",
              status: "completed",
            }],
          }],
          total_count: 1,
        }));
      }
      return Promise.resolve(Response.json(workflowRun));
    });
    const { tool } = toolByName("github_get_workflow_run", { fetch });

    await expect(
      tool.invoke(
        undefined as never,
        JSON.stringify({ repository: "acme/service", runId: 1001 }),
      ),
    ).resolves.toMatchObject({
      conclusion: "failure",
      jobs: [{
        conclusion: "failure",
        steps: [{ conclusion: "failure", name: "Run tests" }],
      }],
      totalJobCount: 1,
    });
  });

  it("reads check summaries and annotations", async () => {
    const fetch = vi.fn().mockImplementation((request: URL | RequestInfo) => {
      const path = new URL(String(request)).pathname;
      if (path.endsWith("/annotations")) {
        return Promise.resolve(Response.json([{
          annotation_level: "failure",
          blob_href: "https://github.com/acme/service/blob/abc/src/test.ts#L4",
          end_column: 10,
          end_line: 4,
          message: "Expected true",
          path: "src/test.ts",
          raw_details: "Assertion failed",
          start_column: 1,
          start_line: 4,
          title: "Test failure",
        }]));
      }
      return Promise.resolve(Response.json(checkRun));
    });
    const { createInstallationToken, tool, tools } = toolByName(
      "github_get_check_run",
      { fetch },
    );

    await expect(
      tool.invoke(
        undefined as never,
        JSON.stringify({ checkRunId: 2002, repository: "acme/service" }),
      ),
    ).resolves.toMatchObject({
      annotations: [{ level: "failure", path: "src/test.ts" }],
      conclusion: "failure",
      name: "test",
    });

    const listTool = tools.find(
      (candidate) => candidate.name === "github_list_check_runs",
    )!;
    fetch.mockResolvedValueOnce(
      Response.json({ check_runs: [checkRun], total_count: 1 }),
    );
    await listTool.invoke(
      undefined as never,
      JSON.stringify({ ref: "main", repository: "acme/service" }),
    );
    expect(createInstallationToken).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized GitHub responses", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response("{}", {
        headers: { "content-length": "2000001" },
      }),
    );
    const { tool } = toolByName("github_list_pull_requests", { fetch });

    await expect(
      tool.invoke(
        undefined as never,
        JSON.stringify({ repository: "acme/service" }),
      ),
    ).resolves.toContain("GitHub response was too large");
  });
});
