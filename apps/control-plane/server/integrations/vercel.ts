import { z } from "zod";

const vercelTokenSchema = z.object({
  access_token: z.string().min(1),
  team_id: z.string().min(1).nullish(),
  user_id: z.string().min(1).nullish(),
  token_type: z.string().optional(),
});

const vercelTeamSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).nullish(),
  slug: z.string().min(1).nullish(),
});

const vercelUserSchema = z.union([
  z.object({
    user: z.object({
      id: z.string().min(1),
      name: z.string().min(1).nullish(),
      username: z.string().min(1).nullish(),
      email: z.string().email().nullish(),
    }),
  }).transform(({ user }) => user),
  z.object({
    id: z.string().min(1),
    name: z.string().min(1).nullish(),
    username: z.string().min(1).nullish(),
    email: z.string().email().nullish(),
  }),
]);

const vercelProjectsPageSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      framework: z.string().nullish(),
      updatedAt: z.number().nullish(),
    }),
  ),
  pagination: z.object({
    next: z.number().nullable().optional(),
  }).optional(),
});

function vercelEnvironment() {
  const integrationSlug = process.env.VERCEL_INTEGRATION_SLUG;
  const clientId = process.env.VERCEL_CLIENT_ID;
  const clientSecret = process.env.VERCEL_CLIENT_SECRET;
  if (!integrationSlug || !clientId || !clientSecret) {
    throw new Error("Vercel Integration credentials are not configured");
  }
  return { integrationSlug, clientId, clientSecret };
}

export class VercelOAuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "VercelOAuthError";
  }
}

export function vercelInstallUrl(state: string): string {
  const { integrationSlug } = vercelEnvironment();
  const url = new URL(
    `/integrations/${encodeURIComponent(integrationSlug)}/new`,
    "https://vercel.com",
  );
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeVercelCode(input: {
  code: string;
  redirectUri: string;
}) {
  const { clientId, clientSecret } = vercelEnvironment();
  const response = await fetch("https://api.vercel.com/v2/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new VercelOAuthError("Vercel authorization failed", response.status);
  }
  return vercelTokenSchema.parse(await response.json());
}

function vercelApiUrl(path: string, teamId?: string | null): URL {
  const url = new URL(path, "https://api.vercel.com");
  if (teamId) url.searchParams.set("teamId", teamId);
  return url;
}

async function vercelGet(
  path: string | URL,
  accessToken: string,
  errorMessage = "Unable to load the Vercel account",
): Promise<unknown> {
  const response = await fetch(path, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new VercelOAuthError(errorMessage, response.status);
  }
  return response.json();
}

function isMissingReadPermission(error: unknown): error is VercelOAuthError {
  return (
    error instanceof VercelOAuthError &&
    (error.status === 401 || error.status === 403)
  );
}

export async function getVercelAccount(input: {
  accessToken: string;
  teamId?: string | null;
  userId?: string | null;
}) {
  if (input.teamId) {
    try {
      const team = vercelTeamSchema.parse(
        await vercelGet(
          vercelApiUrl(`/v2/teams/${encodeURIComponent(input.teamId)}`),
          input.accessToken,
        ),
      );
      return {
        displayName: team.name ?? team.slug ?? "Vercel team",
        externalAccountId: team.id,
        metadata: {
          scope: "team" as const,
          teamId: team.id,
          teamSlug: team.slug ?? undefined,
        },
      };
    } catch (error) {
      if (!isMissingReadPermission(error)) throw error;
      return {
        displayName: "Vercel team",
        externalAccountId: input.teamId,
        metadata: {
          scope: "team" as const,
          teamId: input.teamId,
        },
      };
    }
  }

  try {
    const user = vercelUserSchema.parse(
      await vercelGet("https://api.vercel.com/v2/user", input.accessToken),
    );
    return {
      displayName: user.name ?? user.username ?? user.email ?? "Vercel account",
      externalAccountId: user.id,
      metadata: {
        scope: "personal" as const,
        userId: user.id,
        username: user.username ?? undefined,
      },
    };
  } catch (error) {
    if (!isMissingReadPermission(error) || !input.userId) throw error;
    return {
      displayName: "Vercel account",
      externalAccountId: input.userId,
      metadata: {
        scope: "personal" as const,
        userId: input.userId,
      },
    };
  }
}

export async function listVercelProjects(input: {
  accessToken: string;
  teamId?: string | null;
}) {
  const projects: Array<{
    externalId: string;
    displayName: string;
    metadata: Record<string, unknown>;
  }> = [];
  let until: number | null = null;

  for (let page = 0; page < 100; page += 1) {
    const url = vercelApiUrl("/v9/projects", input.teamId);
    url.searchParams.set("limit", "100");
    if (until !== null) url.searchParams.set("until", String(until));
    const payload = vercelProjectsPageSchema.parse(
      await vercelGet(url, input.accessToken, "Unable to load Vercel projects"),
    );
    projects.push(
      ...payload.projects.map((project) => ({
        externalId: project.id,
        displayName: project.name,
        metadata: {
          framework: project.framework ?? undefined,
          updatedAt: project.updatedAt ?? undefined,
        },
      })),
    );
    until = payload.pagination?.next ?? null;
    if (until === null) return projects;
  }

  throw new Error("Vercel project pagination exceeded the safety limit");
}
