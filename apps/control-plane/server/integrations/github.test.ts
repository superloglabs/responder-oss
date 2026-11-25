import { afterEach, describe, expect, it, vi } from "vitest";
import { listGitHubUserInstallationRepositoryAccess } from "./github.js";

describe("listGitHubUserInstallationRepositoryAccess", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads which of the installation's repositories the user can write to", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      repositories: [
        { id: 1, permissions: { admin: false, maintain: false, pull: true, push: true } },
        { id: 2, permissions: { admin: true, pull: true, push: false } },
        { id: 3, permissions: { admin: false, pull: true, push: false, triage: true } },
        { id: 4 },
        { id: 5, permissions: { admin: false, maintain: true, pull: true, push: false } },
      ],
      total_count: 5,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listGitHubUserInstallationRepositoryAccess("user-token", 12345)).resolves.toEqual([
      { id: "1", write: true },
      { id: "2", write: true },
      { id: "3", write: false },
      { id: "4", write: false },
      { id: "5", write: true },
    ]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://api.github.com/user/installations/12345/repositories?per_page=100&page=1",
    );
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer user-token");
  });

  it("reads every page", async () => {
    const page = (ids: number[]) => Response.json({
      repositories: ids.map((id) => ({ id, permissions: { push: true } })),
      total_count: 101,
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page(Array.from({ length: 100 }, (_, index) => index + 1)))
      .mockResolvedValueOnce(page([101]));
    vi.stubGlobal("fetch", fetchMock);

    const access = await listGitHubUserInstallationRepositoryAccess("user-token", 12345);

    expect(access).toHaveLength(101);
    expect((fetchMock.mock.calls[1]![0] as URL).searchParams.get("page")).toBe("2");
  });

  it("fails when GitHub refuses the request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not Found", { status: 404 })));

    await expect(listGitHubUserInstallationRepositoryAccess("user-token", 12345)).rejects.toThrow();
  });
});
