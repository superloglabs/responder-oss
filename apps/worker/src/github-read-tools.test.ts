import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { describe, expect, it, vi } from "vitest";
import { createGitHubReadTools } from "./github-read-tools.js";

const session = {} as DaytonaSandboxSession;
const sha = "b".repeat(40);
const repository = {
  defaultBranch: "main",
  fullName: "acme/app",
  installationId: 123,
  private: true,
};
const checkout = {
  branch: "main",
  path: "/home/daytona/workspace/repositories/acme/app",
  repository: "acme/app",
  sha: "a".repeat(40),
  workspaceBaseSha: "c".repeat(40),
};

function tools(fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json([{ number: 7 }]))) {
  const dependencies = {
    createInstallationToken: vi.fn().mockResolvedValue("installation-token"),
    fetch: fetchImpl,
    importCommit: vi.fn().mockResolvedValue("d".repeat(40)),
  };
  return {
    dependencies,
    ...createGitHubReadTools({
      checkedOutRepositories: [checkout],
      repositories: async () => [repository],
      session,
    }, dependencies),
  };
}

const resultText = (result: { content: Array<{ text: string }> }) => result.content[0]!.text;

describe("github_api tool", () => {
  it("reads a selected repository with the app token, which stays in the worker", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([{ number: 7 }]), {
      headers: { link: '<https://api.github.com/repos/acme/app/pulls?page=2>; rel="next"' },
    }));
    const { github_api: githubApi, dependencies } = tools(fetchImpl);

    const result = await githubApi!({ path: "/repos/acme/app/pulls?state=open" });

    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toBe([
      "HTTP 200",
      'Link: <https://api.github.com/repos/acme/app/pulls?page=2>; rel="next"',
      "",
      '[{"number":7}]',
    ].join("\n"));
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.github.com/repos/acme/app/pulls?state=open");
    expect(init?.headers).toMatchObject({ authorization: "Bearer installation-token" });
    expect(init?.method).toBeUndefined();
    expect(dependencies.createInstallationToken).toHaveBeenCalledWith(123);
  });

  it("reuses one token for the turn and asks for a diff when requested", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response("diff --git a/x b/x"));
    const { github_api: githubApi, dependencies } = tools(fetchImpl);

    await githubApi!({ path: "/repos/acme/app/pulls/7" });
    await githubApi!({ format: "diff", path: "/repos/ACME/app/compare/main...fix" });

    expect(dependencies.createInstallationToken).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[1]![1]?.headers).toMatchObject({ accept: "application/vnd.github.diff" });
  });

  it("refuses other repositories, other APIs, and other hosts", async () => {
    const { github_api: githubApi, dependencies } = tools();

    for (const path of [
      "/repos/acme/secret/pulls",
      "/repos/acme/app/../secret/pulls",
      "/repos/acme%2Fapp/x/pulls",
      "/user/repos",
      "/orgs/acme/members",
      "https://example.com/repos/acme/app",
      "//example.com/repos/acme/app",
    ]) {
      await expect(githubApi!({ path })).resolves.toMatchObject({ isError: true });
    }
    expect(dependencies.fetch).not.toHaveBeenCalled();
  });

  it("reads a public user profile with a selected repository's app token", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ login: "octocat", name: "The Octocat" }));
    const { github_api: githubApi, dependencies } = tools(fetchImpl);

    const result = await githubApi!({ path: "/users/octocat" });

    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain('"name":"The Octocat"');
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.github.com/users/octocat");
    expect(dependencies.createInstallationToken).toHaveBeenCalledWith(123);
    await githubApi!({ path: "/users/dependabot[bot]" });
    expect(String(fetchImpl.mock.calls[1]![0])).toBe("https://api.github.com/users/dependabot[bot]");

    for (const path of [
      "/users/octocat/repos",
      "/users/octocat?per_page=100",
      "/users/-octocat",
      "/users",
    ]) {
      await expect(githubApi!({ path })).resolves.toMatchObject({ isError: true });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops reading a large download instead of buffering it", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024).fill(120));
        if (pulled > 10_000) controller.close();
      },
    });
    const { github_api: githubApi } = tools(vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));

    const text = resultText(await githubApi!({ path: "/repos/acme/app/zipball/main" }));

    expect(text).toContain("[Response truncated.");
    expect(pulled).toBeLessThan(20);
  });

  it("returns GitHub errors and truncates long responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ message: "Not Found" }, { status: 404 }))
      .mockResolvedValueOnce(new Response("x".repeat(50_000)));
    const { github_api: githubApi } = tools(fetchImpl);

    await expect(githubApi!({ path: "/repos/acme/app/pulls/999" })).resolves.toMatchObject({
      content: [{ text: expect.stringContaining("HTTP 404") }],
      isError: true,
    });
    const long = resultText(await githubApi!({ path: "/repos/acme/app/contents/big.txt" }));
    expect(long).toContain("[Response truncated.");
    expect(long.length).toBeLessThan(41_000);
  });
});

describe("fetch_ref tool", () => {
  it("resolves a branch and imports its files as github/<branch>", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ sha }));
    const { fetch_ref: fetchRef, dependencies } = tools(fetchImpl);

    const result = await fetchRef!({ ref: "release/2026-09", repository: "acme/app" });

    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.github.com/repos/acme/app/commits/release/2026-09");
    expect(dependencies.importCommit).toHaveBeenCalledWith(session, {
      checkout,
      localRef: "refs/remotes/github/release/2026-09",
      ref: "release/2026-09",
      repository,
      sha,
      token: "installation-token",
    });
    expect(JSON.parse(resultText(result))).toMatchObject({ ref: "github/release/2026-09", sha });
  });

  it("resolves a pull request head through the pull request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ head: { sha } }));
    const { fetch_ref: fetchRef, dependencies } = tools(fetchImpl);

    await fetchRef!({ ref: "pull/12/head", repository: "acme/app" });

    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.github.com/repos/acme/app/pulls/12");
    expect(dependencies.importCommit).toHaveBeenCalledWith(session, expect.objectContaining({
      localRef: "refs/remotes/github/pull/12/head",
      sha,
    }));
  });

  it("imports a commit without asking GitHub to resolve it", async () => {
    const { fetch_ref: fetchRef, dependencies } = tools();

    await fetchRef!({ ref: sha, repository: "acme/app" });

    expect(dependencies.fetch).not.toHaveBeenCalled();
    expect(dependencies.importCommit).toHaveBeenCalledWith(session, expect.objectContaining({
      localRef: `refs/remotes/github/commits/${sha}`,
    }));
  });

  it("rejects refs git could misread and repositories that are not checked out", async () => {
    const { fetch_ref: fetchRef, dependencies } = tools();

    for (const ref of ["--upload-pack=x", "main..evil", "a//b", "main.lock", "feature/", "main;rm"]) {
      await expect(fetchRef!({ ref, repository: "acme/app" })).resolves.toMatchObject({ isError: true });
    }
    await expect(fetchRef!({ ref: "main", repository: "acme/other" })).resolves.toMatchObject({ isError: true });
    expect(dependencies.importCommit).not.toHaveBeenCalled();
  });

  it("reports a ref GitHub does not know", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ message: "No commit" }, { status: 422 }));
    const { fetch_ref: fetchRef } = tools(fetchImpl);

    await expect(fetchRef!({ ref: "missing", repository: "acme/app" })).resolves.toMatchObject({
      content: [{ text: "Unable to fetch missing: GitHub could not find missing in acme/app (HTTP 422)" }],
      isError: true,
    });
  });
});
