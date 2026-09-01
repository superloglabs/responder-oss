import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";

const SENTRY_REQUEST_TIMEOUT_MS = 10_000;

const sentryAuthorizationSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  token: z.string().min(1),
  refreshToken: z.string().min(1),
  dateCreated: z.string().optional(),
  expiresAt: z.string().nullable().optional(),
});

export class SentryApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly operation: "authorization" | "installation" | "projects",
  ) {
    super(message);
    this.name = "SentryApiError";
  }
}

export function sentryErrorNeedsReconnect(error: unknown): boolean {
  return error instanceof SentryApiError &&
    (error.httpStatus === 401 ||
      error.httpStatus === 403 ||
      (error.operation === "authorization" && error.httpStatus === 400));
}

const sentryProjectSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  slug: z.string().min(1),
  name: z.string().min(1),
  platform: z.string().nullable().optional(),
});

function sentryEnvironment() {
  const appSlug = process.env.SENTRY_APP_SLUG;
  const clientId = process.env.SENTRY_CLIENT_ID;
  const clientSecret = process.env.SENTRY_CLIENT_SECRET;
  if (!appSlug || !clientId || !clientSecret) {
    throw new Error("Sentry App credentials are not configured");
  }
  return { appSlug, clientId, clientSecret };
}

export function sentryInstallUrl(state: string): string {
  const { appSlug } = sentryEnvironment();
  const url = new URL(
    `https://sentry.io/sentry-apps/${encodeURIComponent(appSlug)}/external-install/`,
  );
  url.searchParams.set("state", state);
  return url.toString();
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function sentryClientSecretJwt(clientId: string, clientSecret: string): string {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const encodedHeader = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const encodedPayload = base64Url(
    JSON.stringify({
      exp: issuedAt + 60,
      iat: issuedAt,
      iss: clientId,
      jti: randomUUID(),
    }),
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", clientSecret)
    .update(signingInput)
    .digest();
  return `${signingInput}.${base64Url(signature)}`;
}

export async function exchangeSentryGrant(input: {
  code: string;
  installationId: string;
}) {
  const { clientId, clientSecret } = sentryEnvironment();
  const response = await fetch(
    `https://sentry.io/api/0/sentry-app-installations/${encodeURIComponent(input.installationId)}/authorizations/`,
    {
      method: "POST",
      signal: AbortSignal.timeout(SENTRY_REQUEST_TIMEOUT_MS),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: input.code,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    },
  );
  if (!response.ok) {
    throw new SentryApiError(
      "Sentry authorization failed",
      response.status,
      "authorization",
    );
  }
  return sentryAuthorizationSchema.parse(await response.json());
}

export async function refreshSentryGrant(input: {
  installationId: string;
  refreshToken: string;
}) {
  const { clientId, clientSecret } = sentryEnvironment();
  const authorizationUrl =
    `https://sentry.io/api/0/sentry-app-installations/${encodeURIComponent(input.installationId)}/authorizations/`;
  const response = await fetch(authorizationUrl, {
    method: "POST",
    signal: AbortSignal.timeout(SENTRY_REQUEST_TIMEOUT_MS),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (response.ok) {
    return sentryAuthorizationSchema.parse(await response.json());
  }

  // Sentry can revoke a refresh token while leaving the installation in place
  // (for example after an administrator changes the app's access). A client
  // secret JWT refreshes the existing installation token without requiring an
  // uninstall/reinstall cycle. Only use it for authorization failures; a
  // timeout or provider outage should remain retryable as-is.
  if (response.status !== 401 && response.status !== 403) {
    throw new SentryApiError(
      "Unable to refresh Sentry access",
      response.status,
      "authorization",
    );
  }

  const manualResponse = await fetch(authorizationUrl, {
    method: "POST",
    signal: AbortSignal.timeout(SENTRY_REQUEST_TIMEOUT_MS),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${sentryClientSecretJwt(clientId, clientSecret)}`,
    },
    body: JSON.stringify({
      grant_type: "urn:sentry:params:oauth:grant-type:jwt-bearer",
    }),
  });
  if (!manualResponse.ok) {
    throw new SentryApiError(
      "Unable to refresh Sentry access",
      manualResponse.status,
      "authorization",
    );
  }
  return sentryAuthorizationSchema.parse(await manualResponse.json());
}

function nextSentryPage(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    if (!/rel="next"/.test(part) || !/results="true"/.test(part)) continue;
    const match = part.match(/<([^>]+)>/);
    if (!match?.[1]) return null;
    const url = new URL(match[1]);
    const trustedHosts = new Set(["sentry.io", "us.sentry.io", "de.sentry.io"]);
    return url.protocol === "https:" && trustedHosts.has(url.hostname)
      ? url.toString()
      : null;
  }
  return null;
}

export async function listSentryProjects(
  accessToken: string,
  organizationSlug: string,
) {
  const projects: Array<z.infer<typeof sentryProjectSchema>> = [];
  let nextUrl: string | null = new URL(
    `/api/0/organizations/${encodeURIComponent(organizationSlug)}/projects/`,
    "https://sentry.io",
  ).toString();

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(SENTRY_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new SentryApiError(
        "Unable to list Sentry projects",
        response.status,
        "projects",
      );
    }
    projects.push(...z.array(sentryProjectSchema).parse(await response.json()));
    nextUrl = nextSentryPage(response.headers.get("link"));
  }

  return projects.map((project) => ({
    externalId: project.id,
    displayName: project.name,
    metadata: {
      organizationSlug,
      platform: project.platform ?? null,
      slug: project.slug,
    },
  }));
}

export async function verifySentryInstallation(
  accessToken: string,
  installationId: string,
): Promise<void> {
  const response = await fetch(
    `https://sentry.io/api/0/sentry-app-installations/${encodeURIComponent(installationId)}/`,
    {
      method: "PUT",
      signal: AbortSignal.timeout(SENTRY_REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "installed" }),
    },
  );
  if (!response.ok) {
    throw new SentryApiError(
      "Unable to verify Sentry installation",
      response.status,
      "installation",
    );
  }
}
