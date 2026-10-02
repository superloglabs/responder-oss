import { afterEach, describe, expect, it, vi } from "vitest";
import { getSentryIssueEventEnvironment, listSentryEnvironments } from "./sentry.js";

describe("Sentry environments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists the organization's environments", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json([
      { id: "1", name: "dev" },
      { id: "2", name: "production" },
    ]));
    vi.stubGlobal("fetch", fetch);

    await expect(listSentryEnvironments("token", "acme")).resolves.toEqual(["dev", "production"]);
    expect(fetch).toHaveBeenCalledWith(
      "https://sentry.io/api/0/organizations/acme/environments/",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer token" }) }),
    );
  });

  it("reads the environment tag of an issue event", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ tags: [{ key: "level", value: "error" }, { key: "environment", value: "staging" }] }))
      .mockResolvedValueOnce(Response.json({ tags: [{ key: "level", value: "error" }] }));
    vi.stubGlobal("fetch", fetch);

    await expect(getSentryIssueEventEnvironment({ accessToken: "token", event: "oldest", issueId: "42", organizationSlug: "acme" }))
      .resolves.toBe("staging");
    expect(fetch).toHaveBeenCalledWith("https://sentry.io/api/0/organizations/acme/issues/42/events/oldest/", expect.anything());
    await expect(getSentryIssueEventEnvironment({ accessToken: "token", event: "latest", issueId: "42", organizationSlug: "acme" }))
      .resolves.toBeNull();
  });
});
