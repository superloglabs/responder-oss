import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGitHubInstallationToken,
  GitHubInstallationNotFoundError,
} from "./github.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ format: "pem", type: "pkcs1" }).toString();

function jwtIssuer(init: RequestInit | undefined): string {
  const authorization = new Headers(init?.headers).get("authorization")!;
  const payload = authorization.replace("Bearer ", "").split(".")[1]!;
  return (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iss: string }).iss;
}

describe("GitHub installation tokens", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reports an installation removed on GitHub", async () => {
    vi.stubEnv("GITHUB_APP_ID", "1");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", pem);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));

    const result = createGitHubInstallationToken(166157288);

    await expect(result).rejects.toBeInstanceOf(GitHubInstallationNotFoundError);
    await expect(result).rejects.toThrow(
      "The GitHub App is no longer installed. Reconnect GitHub in Settings.",
    );
  });

  it("creates the token with the additional app that owns the installation", async () => {
    vi.stubEnv("GITHUB_APP_ID", "1");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", pem);
    vi.stubEnv("GITHUB_ADDITIONAL_APPS", JSON.stringify([{ appId: 2, privateKey: pem.replace(/\n/g, "\\n") }]));
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => jwtIssuer(init) === "2"
      ? Response.json({ expires_at: "2026-10-28T12:00:00Z", token: "ghs_legacy" }, { status: 201 })
      : new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetch);

    await expect(createGitHubInstallationToken(42)).resolves.toBe("ghs_legacy");
    expect(fetch.mock.calls.map(([, init]) => jwtIssuer(init))).toEqual(["1", "2"]);

    fetch.mockClear();
    await expect(createGitHubInstallationToken(42)).resolves.toBe("ghs_legacy");
    expect(fetch.mock.calls.map(([, init]) => jwtIssuer(init))).toEqual(["2"]);
  });

  it("rejects malformed additional apps", async () => {
    vi.stubEnv("GITHUB_APP_ID", "1");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", pem);
    vi.stubEnv("GITHUB_ADDITIONAL_APPS", "[{\"appId\": 2}]");

    await expect(createGitHubInstallationToken(42)).rejects.toThrow(
      "GITHUB_ADDITIONAL_APPS must be a JSON array of { appId, privateKey, webhookSecret }",
    );
  });
});
