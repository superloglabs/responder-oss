import { createSign } from "node:crypto";
import { z } from "zod";
import { type GitHubApp, githubApps } from "./github-apps.js";

const githubInstallationTokenSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string().min(1),
});

const GITHUB_API_VERSION = "2022-11-28";

type GitHubAppCredentials = Pick<GitHubApp, "appId" | "privateKey">;

function configuredGitHubApps(): GitHubApp[] {
  const apps = githubApps();
  if (apps.length === 0) {
    throw new Error("GitHub App credentials are not configured");
  }
  return apps;
}

function encodeJwtPart(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function createGitHubAppJwt(
  credentials: GitHubAppCredentials = configuredGitHubApps()[0]!,
  now = new Date(),
): string {
  const timestamp = Math.floor(now.getTime() / 1_000);
  const unsigned = [
    encodeJwtPart({ alg: "RS256", typ: "JWT" }),
    encodeJwtPart({
      iat: timestamp - 60,
      exp: timestamp + 9 * 60,
      iss: credentials.appId,
    }),
  ].join(".");
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(credentials.privateKey, "base64url")}`;
}

export function githubAppHeaders(token: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": GITHUB_API_VERSION,
    "user-agent": "Responder",
  };
}

// The installation was removed or never existed, for example after someone
// uninstalled the GitHub App from their account.
export class GitHubInstallationNotFoundError extends Error {
  constructor(readonly installationId: number) {
    super("The GitHub App is no longer installed. Reconnect GitHub in Settings.");
    this.name = "GitHubInstallationNotFoundError";
  }
}

// The app that owns each installation seen so far. An installation belongs to
// one app, and only that app can create its tokens.
const installationApps = new Map<number, string>();

// Asks each configured app for a token, starting with the one that last owned
// the installation, so connections to an additional app need no record of it.
export async function createGitHubInstallationToken(
  installationId: number,
  signal?: AbortSignal,
): Promise<string> {
  const apps = configuredGitHubApps();
  const knownAppId = installationApps.get(installationId);
  const ordered = knownAppId
    ? [...apps.filter((app) => app.appId === knownAppId), ...apps.filter((app) => app.appId !== knownAppId)]
    : apps;
  for (const app of ordered) {
    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: githubAppHeaders(createGitHubAppJwt(app)),
        signal,
      },
    );
    if (response.status === 404) continue;
    if (!response.ok) {
      throw new Error("Unable to create GitHub installation token");
    }
    installationApps.set(installationId, app.appId);
    return githubInstallationTokenSchema.parse(await response.json()).token;
  }
  installationApps.delete(installationId);
  throw new GitHubInstallationNotFoundError(installationId);
}
