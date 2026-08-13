import { createSign } from "node:crypto";
import { z } from "zod";

const githubInstallationTokenSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string().min(1),
});

const GITHUB_API_VERSION = "2022-11-28";

interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
}

function githubAppCredentials(
  environment: NodeJS.ProcessEnv = process.env,
): GitHubAppCredentials {
  const appId = environment.GITHUB_APP_ID;
  const privateKey = environment.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!appId || !privateKey) {
    throw new Error("GitHub App credentials are not configured");
  }
  return { appId, privateKey };
}

function encodeJwtPart(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function createGitHubAppJwt(
  credentials = githubAppCredentials(),
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

export async function createGitHubInstallationToken(
  installationId: number,
): Promise<string> {
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: githubAppHeaders(createGitHubAppJwt()),
    },
  );
  if (!response.ok) {
    throw new Error("Unable to create GitHub installation token");
  }
  return githubInstallationTokenSchema.parse(await response.json()).token;
}
