import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubInstallationToken } from "./github.js";

describe("GitHub installation tokens", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("requests a repository-scoped token with reduced permissions", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    vi.stubEnv("GITHUB_APP_ID", "12345");
    vi.stubEnv(
      "GITHUB_APP_PRIVATE_KEY",
      privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    );
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        expires_at: "2026-09-18T12:00:00Z",
        token: "installation-token",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createGitHubInstallationToken(42, {
        permissions: {
          actions: "read",
          checks: "read",
          contents: "read",
          metadata: "read",
          pull_requests: "read",
        },
        repositories: ["service"],
      }),
    ).resolves.toBe("installation-token");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/app/installations/42/access_tokens",
      expect.objectContaining({
        body: JSON.stringify({
          permissions: {
            actions: "read",
            checks: "read",
            contents: "read",
            metadata: "read",
            pull_requests: "read",
          },
          repositories: ["service"],
        }),
        method: "POST",
      }),
    );
  });
});
