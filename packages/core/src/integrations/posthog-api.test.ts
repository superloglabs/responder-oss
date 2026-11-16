import { describe, expect, it, vi } from "vitest";
import { PostHogApiError, type PostHogFetch, postHogAccount, postHogProjects } from "./posthog-api.js";

const me = {
  organization: { id: "org-1", name: "Acme", teams: [{ id: 1, name: "Web" }, { id: 2, name: "Staging" }] },
  organizations: [{ id: "org-1", name: "Acme" }, { id: "org-2", name: "Side project" }, { id: "org-3", name: "Locked" }],
};

function api(routes: Record<string, () => Response>, home = "eu.posthog.com") {
  return vi.fn<PostHogFetch>(async (url, init) => {
    expect(init.headers).toEqual(expect.objectContaining({ authorization: "Bearer token" }));
    const { host, pathname, search } = new URL(url);
    if (host !== home) return Response.json({ detail: "Invalid token" }, { status: 401 });
    return routes[pathname + search]?.() ?? Response.json({ detail: "Not found" }, { status: 404 });
  });
}

describe("postHogAccount", () => {
  it("uses the region that accepts the token", async () => {
    const fetchFn = api({ "/api/users/@me/": () => Response.json(me) }, "us.posthog.com");
    expect((await postHogAccount({ accessToken: "token", fetch: fetchFn })).host).toBe("https://us.posthog.com");
  });

  it("reports a refusal that is not the other region's 401", async () => {
    const forbidden = api({ "/api/users/@me/": () => Response.json({ detail: "Missing scope user:read" }, { status: 403 }) });
    await expect(postHogAccount({ accessToken: "token", fetch: forbidden })).rejects.toThrow(
      "PostHog API request failed (HTTP 403): Missing scope user:read",
    );

    const neither = api({}, "nowhere");
    await expect(postHogAccount({ accessToken: "token", fetch: neither })).rejects.toBeInstanceOf(PostHogApiError);
  });
});

describe("postHogProjects", () => {
  it("lists the current organization's projects, then the others' it can read", async () => {
    const fetchFn = api({
      "/api/users/@me/": () => Response.json(me),
      "/api/organizations/org-2/projects/": () => Response.json({
        next: "https://eu.posthog.com/api/organizations/org-2/projects/?offset=1",
        results: [{ id: 3, name: "Side" }],
      }),
      "/api/organizations/org-2/projects/?offset=1": () => Response.json({ next: null, results: [{ id: 4, name: "" }] }),
      "/api/organizations/org-3/projects/": () => Response.json({ detail: "No access" }, { status: 403 }),
    });
    expect(await postHogProjects({ accessToken: "token", fetch: fetchFn })).toEqual({
      host: "https://eu.posthog.com",
      projects: [
        { id: "1", name: "Web", organizationName: "Acme" },
        { id: "2", name: "Staging", organizationName: "Acme" },
        { id: "3", name: "Side", organizationName: "Side project" },
        { id: "4", name: "Project 4", organizationName: "Side project" },
      ],
    });
  });
});
