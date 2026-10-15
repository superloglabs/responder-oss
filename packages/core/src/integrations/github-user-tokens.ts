import { z } from "zod";
import { githubAppHeaders } from "./github.js";

// A GitHub App user access token. It acts as the user, limited to what both
// the user and the app may do. When the app's user tokens expire, one lasts
// eight hours and its single-use refresh token six months.
export interface GitHubUserCredentials extends Record<string, unknown> {
  accessToken: string;
  accessTokenExpiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
}

export interface GitHubUserTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  refresh_token_expires_in: z.number().optional(),
});
const tokenErrorSchema = z.object({ error: z.string().min(1) });
const githubUserSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
});

// A token this close to expiring is refreshed before use, so it cannot
// expire while a pull request is being opened.
const refreshMarginMs = 5 * 60_000;

export function githubUserCredentials(
  response: GitHubUserTokenResponse,
  now = new Date(),
): GitHubUserCredentials {
  const at = (seconds: number | undefined) =>
    seconds === undefined ? undefined : new Date(now.getTime() + seconds * 1_000).toISOString();
  return {
    accessToken: response.access_token,
    ...(response.expires_in === undefined ? {} : { accessTokenExpiresAt: at(response.expires_in) }),
    ...(response.refresh_token === undefined ? {} : { refreshToken: response.refresh_token }),
    ...(response.refresh_token_expires_in === undefined
      ? {}
      : { refreshTokenExpiresAt: at(response.refresh_token_expires_in) }),
  };
}

export function githubUserCredentialsNeedRefresh(
  credentials: GitHubUserCredentials,
  now = new Date(),
): boolean {
  return credentials.accessTokenExpiresAt !== undefined &&
    Date.parse(credentials.accessTokenExpiresAt) - now.getTime() <= refreshMarginMs;
}

export function githubUserCredentialsExpired(
  credentials: GitHubUserCredentials,
  now = new Date(),
): boolean {
  return credentials.accessTokenExpiresAt !== undefined &&
    Date.parse(credentials.accessTokenExpiresAt) <= now.getTime();
}

// GitHub no longer accepts the token, for example after the user revoked the
// app's authorization or the refresh token expired. Connecting again fixes it.
export class GitHubUserTokenRejectedError extends Error {
  constructor(reason: string) {
    super(`GitHub rejected the user token: ${reason}`);
    this.name = "GitHubUserTokenRejectedError";
  }
}

export async function refreshGitHubUserToken(
  credentials: GitHubUserCredentials,
  options: {
    environment?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    now?: Date;
  } = {},
): Promise<GitHubUserCredentials> {
  const environment = options.environment ?? process.env;
  const now = options.now ?? new Date();
  if (
    !credentials.refreshToken ||
    (credentials.refreshTokenExpiresAt && Date.parse(credentials.refreshTokenExpiresAt) <= now.getTime())
  ) {
    throw new GitHubUserTokenRejectedError("refresh_token_expired");
  }
  const clientId = environment.GITHUB_CLIENT_ID;
  const clientSecret = environment.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GitHub App credentials are not configured");
  const response = await (options.fetch ?? fetch)("https://github.com/login/oauth/access_token", {
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
    }),
    headers: { accept: "application/json", "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  const failure = tokenErrorSchema.safeParse(payload);
  if (failure.success) {
    // Any other error, such as a misconfigured client, is not the token's.
    if (failure.data.error === "bad_refresh_token") {
      throw new GitHubUserTokenRejectedError(failure.data.error);
    }
    throw new Error(`Unable to refresh the GitHub user token: ${failure.data.error.slice(0, 100)}`);
  }
  const token = tokenResponseSchema.safeParse(payload);
  if (!response.ok || !token.success) {
    throw new Error(`Unable to refresh the GitHub user token (${response.status})`);
  }
  return githubUserCredentials(token.data, now);
}

export async function getGitHubUser(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<z.infer<typeof githubUserSchema>> {
  const response = await fetchImpl("https://api.github.com/user", {
    headers: githubAppHeaders(accessToken),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Unable to read the GitHub user (${response.status})`);
  return githubUserSchema.parse(await response.json());
}
