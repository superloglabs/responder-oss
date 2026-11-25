import {
  createGitHubInstallationToken,
  githubAppHeaders,
} from "../../../../packages/core/src/integrations/github.js";
import { z } from "zod";
import { integrationCallbackUrl } from "./urls.js";

const githubTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  refresh_token_expires_in: z.number().optional(),
});

const githubTokenErrorSchema = z.object({
  error: z.string().min(1).max(100).regex(/^[a-z0-9_]+$/),
});

export class GitHubOAuthError extends Error {
  constructor(readonly githubCode: string) {
    super(`GitHub OAuth token exchange failed: ${githubCode}`);
    this.name = "GitHubOAuthError";
  }
}

const githubInstallationSchema = z.object({
  id: z.number().int().positive(),
  repository_selection: z.string(),
  account: z.object({
    id: z.number().int().positive(),
    login: z.string().min(1),
    type: z.string().min(1),
  }),
});

const githubInstallationsResponseSchema = z.object({
  installations: z.array(githubInstallationSchema),
  total_count: z.number(),
});

const githubRepositoriesResponseSchema = z.object({
  repositories: z.array(
    z.object({
      id: z.number().int().positive(),
      full_name: z.string().min(1),
      default_branch: z.string().min(1),
      private: z.boolean(),
      html_url: z.string().url(),
      owner: z.object({ login: z.string().min(1) }),
    }),
  ),
  total_count: z.number(),
});

function githubEnvironment() {
  const appId = process.env.GITHUB_APP_ID;
  const appSlug = process.env.GITHUB_APP_SLUG;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!appId || !appSlug || !privateKey || !clientId || !clientSecret) {
    throw new Error("GitHub App credentials are not configured");
  }
  return { appId, appSlug, privateKey, clientId, clientSecret };
}

export function githubAuthorizeUrl(state: string): string {
  const { clientId } = githubEnvironment();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", integrationCallbackUrl("github"));
  return url.toString();
}

export function githubInstallUrl(state: string): string {
  const { appSlug } = githubEnvironment();
  const url = new URL(`https://github.com/apps/${appSlug}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGitHubCode(
  code: string,
  redirectUri = integrationCallbackUrl("github"),
) {
  const { clientId, clientSecret } = githubEnvironment();
  const body: Record<string, string> = {
    client_id: clientId,
    client_secret: clientSecret,
    code,
  };
  if (redirectUri) body.redirect_uri = redirectUri;
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  const parsedError = githubTokenErrorSchema.safeParse(payload);
  if (parsedError.success) {
    throw new GitHubOAuthError(parsedError.data.error);
  }
  if (!response.ok) {
    throw new GitHubOAuthError(`http_${response.status}`);
  }

  const parsedToken = githubTokenResponseSchema.safeParse(payload);
  if (!parsedToken.success) {
    throw new GitHubOAuthError("invalid_response");
  }
  return parsedToken.data;
}

export async function listGitHubUserInstallations(userAccessToken: string) {
  const installations: Array<z.infer<typeof githubInstallationSchema>> = [];
  let page = 1;
  while (true) {
    const url = new URL("https://api.github.com/user/installations");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await fetch(url, {
      headers: githubAppHeaders(userAccessToken),
    });
    if (!response.ok) throw new Error("Unable to verify GitHub App installation");

    const payload = githubInstallationsResponseSchema.parse(await response.json());
    installations.push(...payload.installations);
    if (page * 100 >= payload.total_count) break;
    page += 1;
  }

  return installations;
}

export async function verifyGitHubUserInstallation(
  userAccessToken: string,
  installationId: number,
) {
  const installations = await listGitHubUserInstallations(userAccessToken);
  const installation = installations.find(
    (candidate) => candidate.id === installationId,
  );
  if (installation) return installation;

  throw new Error("GitHub App installation does not belong to the connecting user");
}

const githubUserRepositoriesResponseSchema = z.object({
  repositories: z.array(
    z.object({
      id: z.number().int().positive(),
      permissions: z
        .object({
          admin: z.boolean().optional(),
          maintain: z.boolean().optional(),
          push: z.boolean().optional(),
        })
        .optional(),
    }),
  ),
  total_count: z.number().int().nonnegative(),
});

export type GitHubInstallationAccessProblem =
  | "partial_repository_access"
  | "read_only_repository_access";

// A connection lets Superlog change code in every repository its installation
// covers, so the connecting user must be able to see and write to all of
// them, not only some.
export class GitHubInstallationAccessError extends Error {
  constructor(
    readonly installationId: number,
    readonly reason: GitHubInstallationAccessProblem,
  ) {
    super(
      reason === "read_only_repository_access"
        ? "The GitHub user cannot write to every repository of the installation"
        : "The GitHub user cannot see every repository of the installation",
    );
    this.name = "GitHubInstallationAccessError";
  }
}

// The installation's repositories the user can reach, and whether the user
// can push to each. The user token only reaches repositories that both the
// user and the installation can access. A repository without permissions in
// the response counts as read only.
export async function listGitHubUserInstallationRepositoryAccess(
  userAccessToken: string,
  installationId: number,
): Promise<Array<{ id: string; write: boolean }>> {
  const access: Array<{ id: string; write: boolean }> = [];
  let page = 1;
  while (true) {
    const url = new URL(
      `https://api.github.com/user/installations/${installationId}/repositories`,
    );
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await fetch(url, {
      headers: githubAppHeaders(userAccessToken),
    });
    if (!response.ok) {
      throw new Error("Unable to list the GitHub user's installation repositories");
    }
    const payload = githubUserRepositoriesResponseSchema.parse(await response.json());
    access.push(
      ...payload.repositories.map((repository) => ({
        id: String(repository.id),
        write: Boolean(
          repository.permissions?.push ||
            repository.permissions?.maintain ||
            repository.permissions?.admin,
        ),
      })),
    );
    if (payload.repositories.length === 0 || page * 100 >= payload.total_count) break;
    page += 1;
  }
  return access;
}

// Null when the user can write to exactly the repositories the installation
// covers.
export function githubInstallationAccessProblem(
  repositories: ReadonlyArray<{ externalId: string }>,
  access: ReadonlyArray<{ id: string; write: boolean }>,
): GitHubInstallationAccessProblem | null {
  const writable = new Map(access.map((repository) => [repository.id, repository.write]));
  if (
    access.length !== repositories.length ||
    repositories.some((repository) => !writable.has(repository.externalId))
  ) {
    return "partial_repository_access";
  }
  if (repositories.some((repository) => writable.get(repository.externalId) !== true)) {
    return "read_only_repository_access";
  }
  return null;
}

export async function listGitHubRepositories(installationId: number) {
  const installationToken = await createGitHubInstallationToken(installationId);
  const repositories: Array<{
    externalId: string;
    fullName: string;
    defaultBranch: string;
    private: boolean;
    metadata: Record<string, unknown>;
  }> = [];
  let page = 1;

  while (true) {
    const url = new URL("https://api.github.com/installation/repositories");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await fetch(url, {
      headers: githubAppHeaders(installationToken),
    });
    if (!response.ok) throw new Error("Unable to list GitHub repositories");

    const payload = githubRepositoriesResponseSchema.parse(await response.json());
    repositories.push(
      ...payload.repositories.map((repository) => ({
        externalId: String(repository.id),
        fullName: repository.full_name,
        defaultBranch: repository.default_branch,
        private: repository.private,
        metadata: {
          htmlUrl: repository.html_url,
          owner: repository.owner.login,
        },
      })),
    );
    if (page * 100 >= payload.total_count) break;
    page += 1;
  }

  return repositories;
}
