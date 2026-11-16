import { z } from "zod";

// PostHog's REST API, read with a PostHog connection's OAuth token. The
// token is issued by PostHog's region-agnostic OAuth server, and only the
// account's home region accepts it.

export const postHogApiHosts = ["https://us.posthog.com", "https://eu.posthog.com"] as const;
export type PostHogApiHost = (typeof postHogApiHosts)[number];
export const postHogApiHostSchema = z.enum(postHogApiHosts);

export type PostHogFetch = (input: string, init: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 10_000_000;

export class PostHogApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "PostHogApiError";
  }
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`PostHog response exceeded the ${Math.round(maxBytes / 1000)} KB limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function errorDetail(text: string): string {
  try {
    const body = JSON.parse(text) as { detail?: unknown; error?: unknown };
    const detail = typeof body.detail === "string" ? body.detail : typeof body.error === "string" ? body.error : "";
    return detail.slice(0, 300);
  } catch {
    return "";
  }
}

export async function postHogRequest<T>(input: {
  accessToken: string;
  body?: unknown;
  fetch?: PostHogFetch;
  host: PostHogApiHost;
  maxResponseBytes?: number;
  path: string;
}): Promise<T> {
  const response = await (input.fetch ?? fetch)(`${input.host}${input.path}`, {
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.accessToken}`,
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
    },
    method: input.body === undefined ? "GET" : "POST",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await boundedText(response, input.maxResponseBytes ?? MAX_RESPONSE_BYTES);
  if (!response.ok) {
    const detail = errorDetail(text);
    throw new PostHogApiError(response.status, `PostHog API request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PostHogApiError(response.status, "PostHog answered with something other than JSON");
  }
}

const namedSchema = z.object({ id: z.union([z.number(), z.string()]).transform(String), name: z.string().catch("") });
const meSchema = z.object({
  organization: namedSchema.extend({ teams: z.array(namedSchema).catch([]) }).nullish(),
  organizations: z.array(namedSchema).catch([]),
});
const projectPageSchema = z.object({ next: z.string().nullish(), results: z.array(namedSchema) });

export interface PostHogProject {
  // The project's (environment's) ID, which the logs API is addressed by.
  id: string;
  name: string;
  organizationName: string;
}

/**
 * The region whose API accepts the token, and the account it acts as. The
 * other region answers 401, as PostHog's own MCP server finds it.
 */
export async function postHogAccount(input: { accessToken: string; fetch?: PostHogFetch }): Promise<{
  host: PostHogApiHost;
  me: z.infer<typeof meSchema>;
}> {
  const attempts = await Promise.allSettled(postHogApiHosts.map(async (host) => ({
    host,
    me: meSchema.parse(await postHogRequest({ ...input, host, path: "/api/users/@me/" })),
  })));
  const found = attempts.find((attempt) => attempt.status === "fulfilled");
  if (found?.status === "fulfilled") return found.value;
  const refused = attempts.find(
    (attempt): attempt is PromiseRejectedResult =>
      attempt.status === "rejected" && !(attempt.reason instanceof PostHogApiError && attempt.reason.status === 401),
  );
  throw refused?.reason ?? new PostHogApiError(401, "Neither PostHog region accepted the connection's access");
}

const MAX_PROJECT_PAGES = 5;

/**
 * The projects the token can read: those of the account's current
 * organization, then those of its other organizations. An organization
 * whose projects cannot be listed is left out.
 */
export async function postHogProjects(input: { accessToken: string; fetch?: PostHogFetch }): Promise<{
  host: PostHogApiHost;
  projects: PostHogProject[];
}> {
  const { host, me } = await postHogAccount(input);
  const projects: PostHogProject[] = [];
  const seen = new Set<string>();
  const add = (organizationName: string, project: { id: string; name: string }) => {
    if (seen.has(project.id)) return;
    seen.add(project.id);
    projects.push({ id: project.id, name: project.name || `Project ${project.id}`, organizationName });
  };
  for (const team of me.organization?.teams ?? []) add(me.organization?.name ?? "", team);
  for (const organization of me.organizations) {
    if (organization.id === me.organization?.id) continue;
    try {
      let path: string | null = `/api/organizations/${encodeURIComponent(organization.id)}/projects/`;
      for (let page = 0; path && page < MAX_PROJECT_PAGES; page += 1) {
        const listed = projectPageSchema.parse(await postHogRequest({ ...input, host, path }));
        for (const project of listed.results) add(organization.name, project);
        path = listed.next ? new URL(listed.next).pathname + new URL(listed.next).search : null;
      }
    } catch {
      // The token may not reach this organization.
    }
  }
  return { host, projects };
}
