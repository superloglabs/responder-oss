import { Hono } from "hono";
import {
  getGitHubPullRequestAuthor,
  removeGitHubPullRequestAuthor,
  setGitHubPullRequestAuthor,
} from "../../../../packages/core/src/db/github-pull-request-authors.js";
import {
  createIntegrationConnectionState,
  listConnectedIntegrationAccounts,
} from "../../../../packages/core/src/db/integrations.js";
import {
  getGitHubUser,
  githubUserCredentials,
} from "../../../../packages/core/src/integrations/github-user-tokens.js";
import { getActiveTenant } from "../tenant.js";
import {
  exchangeGitHubCode,
  githubAuthorizeUrl,
  listGitHubUserInstallations,
} from "./github.js";
import { cellCallbackUrl, integrationCallbackUrl, settingsRedirect } from "./urls.js";

// GitHub authorization started from the pull request author setting returns
// through the GitHub callback with this purpose in its connection state.
export const githubPullRequestAuthorPurpose = "pull_request_author";

export class GitHubPullRequestAuthorError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = "GitHubPullRequestAuthorError";
  }
}

function isWorkspaceAdmin(role: string): boolean {
  return role.split(",").some((part) => part === "admin" || part === "owner");
}

// Saves the authorizing member's GitHub token as the workspace's pull request
// author. Their account must reach one of the workspace's GitHub App
// installations, since the token only works there.
export async function completeGitHubPullRequestAuthorConnection(
  input: { code: string; organizationId: string; userId: string },
  dependencies = {
    exchangeCode: exchangeGitHubCode,
    getUser: getGitHubUser,
    listConnectedInstallations: (organizationId: string) =>
      listConnectedIntegrationAccounts(organizationId, "github"),
    listUserInstallations: listGitHubUserInstallations,
    save: setGitHubPullRequestAuthor,
  },
): Promise<{ githubLogin: string }> {
  const token = await dependencies.exchangeCode(input.code, integrationCallbackUrl("github"));
  const [githubUser, userInstallations, connected] = await Promise.all([
    dependencies.getUser(token.access_token),
    dependencies.listUserInstallations(token.access_token),
    dependencies.listConnectedInstallations(input.organizationId),
  ]);
  const connectedIds = new Set(connected.map((account) => account.externalAccountId));
  if (!userInstallations.some((installation) => connectedIds.has(String(installation.id)))) {
    throw new GitHubPullRequestAuthorError(
      "no_shared_installation",
      "The GitHub account cannot access the workspace's GitHub installation",
    );
  }
  await dependencies.save({
    credentials: githubUserCredentials(token),
    githubLogin: githubUser.login,
    githubUserId: githubUser.id,
    organizationId: input.organizationId,
    userId: input.userId,
  });
  return { githubLogin: githubUser.login };
}

export const githubPullRequestAuthorRoutes = new Hono()
  .get("/", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) return context.json({ error: tenant.error }, tenant.status);
    const author = await getGitHubPullRequestAuthor(tenant.organizationId);
    const appSlug = process.env.GITHUB_APP_SLUG;
    return context.json({
      // The bot account GitHub shows on pull requests the GitHub App opens.
      appLogin: appSlug ? `${appSlug}[bot]` : null,
      author: author
        ? {
            githubLogin: author.githubLogin,
            status: author.status,
            updatedAt: author.updatedAt.toISOString(),
            user: { id: author.user.id, name: author.user.name },
          }
        : null,
      canRemove: author
        ? author.user.id === tenant.user.id || isWorkspaceAdmin(tenant.role)
        : false,
    });
  })
  // Any member may open pull requests as themselves. Authorizing on GitHub is
  // their consent.
  .get("/start", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) return context.json({ error: tenant.error }, tenant.status);
    const returnTo = context.req.query("returnTo") ?? "/settings/workspace";
    try {
      const state = await createIntegrationConnectionState({
        metadata: { purpose: githubPullRequestAuthorPurpose },
        organizationId: tenant.organizationId,
        provider: "github",
        returnTo,
        routingUrl: cellCallbackUrl("github"),
        userId: tenant.user.id,
      });
      return context.redirect(githubAuthorizeUrl(state));
    } catch (error) {
      console.error(JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
        event: "github_pull_request_author_start_failed",
      }));
      return context.redirect(settingsRedirect(returnTo, "github", "error", "connection_failed"));
    }
  })
  // The member themselves or a workspace admin can stop it. Pull requests
  // are then opened by the GitHub App again.
  .delete("/", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) return context.json({ error: tenant.error }, tenant.status);
    const author = await getGitHubPullRequestAuthor(tenant.organizationId);
    if (author && author.user.id !== tenant.user.id && !isWorkspaceAdmin(tenant.role)) {
      return context.json({ error: "Only the member or a workspace admin can change this" }, 403);
    }
    await removeGitHubPullRequestAuthor(tenant.organizationId);
    return context.body(null, 204);
  });
