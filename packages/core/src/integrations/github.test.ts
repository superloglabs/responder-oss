import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGitHubInstallationToken,
  GitHubInstallationNotFoundError,
} from "./github.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

describe("GitHub installation tokens", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reports an installation removed on GitHub", async () => {
    vi.stubEnv("GITHUB_APP_ID", "1");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey.export({ format: "pem", type: "pkcs1" }).toString());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));

    const result = createGitHubInstallationToken(166157288);

    await expect(result).rejects.toBeInstanceOf(GitHubInstallationNotFoundError);
    await expect(result).rejects.toThrow(
      "The GitHub App is no longer installed. Reconnect GitHub in Settings.",
    );
  });
});
