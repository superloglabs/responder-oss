import { z } from "zod";

const sentryAuthorizationSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  token: z.string().min(1),
  refreshToken: z.string().min(1),
  dateCreated: z.string().optional(),
  expiresAt: z.string().optional(),
});

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

export async function exchangeSentryGrant(input: {
  code: string;
  installationId: string;
}) {
  const { clientId, clientSecret } = sentryEnvironment();
  const response = await fetch(
    `https://sentry.io/api/0/sentry-app-installations/${encodeURIComponent(input.installationId)}/authorizations/`,
    {
      method: "POST",
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
    throw new Error(`Sentry authorization failed with HTTP ${response.status}`);
  }
  return sentryAuthorizationSchema.parse(await response.json());
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
    });
    if (!response.ok) {
      throw new Error(`Unable to list Sentry projects (HTTP ${response.status})`);
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
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "installed" }),
    },
  );
  if (!response.ok) {
    throw new Error(`Unable to verify Sentry installation (HTTP ${response.status})`);
  }
}
