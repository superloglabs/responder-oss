import { afterEach, describe, expect, it, vi } from "vitest";
import { countGitHubUserInstallationRepositories } from "./github.js";

describe("countGitHubUserInstallationRepositories", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads how many of the installation's repositories the user can see", async () => {
    const fetchMock = vi.fn(async () => Response.json({ repositories: [], total_count: 3 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(countGitHubUserInstallationRepositories("user-token", 12345)).resolves.toBe(3);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://api.github.com/user/installations/12345/repositories?per_page=1",
    );
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer user-token");
  });

  it("fails when GitHub refuses the request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not Found", { status: 404 })));

    await expect(countGitHubUserInstallationRepositories("user-token", 12345)).rejects.toThrow();
  });
});
