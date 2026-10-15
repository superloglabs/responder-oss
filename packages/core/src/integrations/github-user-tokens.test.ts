import { describe, expect, it, vi } from "vitest";
import {
  GitHubUserTokenRejectedError,
  githubUserCredentials,
  githubUserCredentialsExpired,
  githubUserCredentialsNeedRefresh,
  refreshGitHubUserToken,
} from "./github-user-tokens.js";

const now = new Date("2026-10-15T12:00:00Z");
const environment = { GITHUB_CLIENT_ID: "client-id", GITHUB_CLIENT_SECRET: "client-secret" };

describe("GitHub user tokens", () => {
  it("records when an expiring token and its refresh token expire", () => {
    expect(githubUserCredentials({
      access_token: "ghu_access",
      expires_in: 28_800,
      refresh_token: "ghr_refresh",
      refresh_token_expires_in: 15_811_200,
    }, now)).toEqual({
      accessToken: "ghu_access",
      accessTokenExpiresAt: "2026-10-15T20:00:00.000Z",
      refreshToken: "ghr_refresh",
      refreshTokenExpiresAt: "2027-04-16T12:00:00.000Z",
    });
  });

  it("keeps a token that does not expire as it is", () => {
    const credentials = githubUserCredentials({ access_token: "ghu_access" }, now);

    expect(credentials).toEqual({ accessToken: "ghu_access" });
    expect(githubUserCredentialsNeedRefresh(credentials, now)).toBe(false);
    expect(githubUserCredentialsExpired(credentials, now)).toBe(false);
  });

  it("refreshes a token in its last five minutes", () => {
    const credentials = { accessToken: "ghu_access", accessTokenExpiresAt: "2026-10-15T12:06:00.000Z" };

    expect(githubUserCredentialsNeedRefresh(credentials, now)).toBe(false);
    expect(githubUserCredentialsNeedRefresh(credentials, new Date("2026-10-15T12:01:00Z"))).toBe(true);
    expect(githubUserCredentialsExpired(credentials, new Date("2026-10-15T12:01:00Z"))).toBe(false);
  });

  it("exchanges the refresh token for new credentials", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      access_token: "ghu_new",
      expires_in: 28_800,
      refresh_token: "ghr_new",
      refresh_token_expires_in: 15_811_200,
      token_type: "bearer",
    }));

    await expect(refreshGitHubUserToken(
      { accessToken: "ghu_old", refreshToken: "ghr_old" },
      { environment, fetch: fetchMock, now },
    )).resolves.toMatchObject({ accessToken: "ghu_new", refreshToken: "ghr_new" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      grant_type: "refresh_token",
      refresh_token: "ghr_old",
    });
  });

  it("reports a refresh token GitHub rejects", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "bad_refresh_token" }));

    await expect(refreshGitHubUserToken(
      { accessToken: "ghu_old", refreshToken: "ghr_old" },
      { environment, fetch: fetchMock, now },
    )).rejects.toBeInstanceOf(GitHubUserTokenRejectedError);
  });

  it("does not blame the token for other refresh errors", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "incorrect_client_credentials" }));

    const refresh = refreshGitHubUserToken(
      { accessToken: "ghu_old", refreshToken: "ghr_old" },
      { environment, fetch: fetchMock, now },
    );

    await expect(refresh).rejects.toThrow("incorrect_client_credentials");
    await expect(refresh).rejects.not.toBeInstanceOf(GitHubUserTokenRejectedError);
  });

  it("does not try an expired refresh token", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    await expect(refreshGitHubUserToken(
      { accessToken: "ghu_old", refreshToken: "ghr_old", refreshTokenExpiresAt: "2026-10-15T11:00:00.000Z" },
      { environment, fetch: fetchMock, now },
    )).rejects.toBeInstanceOf(GitHubUserTokenRejectedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
