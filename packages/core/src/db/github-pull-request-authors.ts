import { and, eq } from "drizzle-orm";
import {
  decryptCredentials,
  encryptCredentials,
} from "../credentials/encryption.js";
import {
  GitHubUserTokenRejectedError,
  githubUserCredentialsExpired,
  githubUserCredentialsNeedRefresh,
  refreshGitHubUserToken,
  type GitHubUserCredentials,
} from "../integrations/github-user-tokens.js";
import { member, user } from "./auth-schema.js";
import { getDatabase } from "./client.js";
import {
  githubMemberPullRequestBranches,
  githubPullRequestAuthors,
} from "./schema.js";

export interface GitHubPullRequestAuthorSummary {
  githubLogin: string;
  status: "connected" | "error";
  updatedAt: Date;
  user: { email: string; id: string; name: string };
}

// The member set to open the workspace's pull requests, while they are still
// a member.
export async function getGitHubPullRequestAuthor(
  organizationId: string,
): Promise<GitHubPullRequestAuthorSummary | null> {
  const rows = await getDatabase()
    .select({
      email: user.email,
      githubLogin: githubPullRequestAuthors.githubLogin,
      name: user.name,
      status: githubPullRequestAuthors.status,
      updatedAt: githubPullRequestAuthors.updatedAt,
      userId: githubPullRequestAuthors.userId,
    })
    .from(githubPullRequestAuthors)
    .innerJoin(user, eq(user.id, githubPullRequestAuthors.userId))
    .innerJoin(member, and(
      eq(member.organizationId, githubPullRequestAuthors.organizationId),
      eq(member.userId, githubPullRequestAuthors.userId),
    ))
    .where(eq(githubPullRequestAuthors.organizationId, organizationId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    githubLogin: row.githubLogin,
    status: row.status === "connected" ? "connected" : "error",
    updatedAt: row.updatedAt,
    user: { email: row.email, id: row.userId, name: row.name },
  };
}

// Replaces any member set before.
export async function setGitHubPullRequestAuthor(input: {
  credentials: GitHubUserCredentials;
  githubLogin: string;
  githubUserId: number;
  organizationId: string;
  userId: string;
}): Promise<void> {
  const now = new Date();
  const values = {
    encryptedCredentials: encryptCredentials(input.credentials),
    githubLogin: input.githubLogin,
    githubUserId: input.githubUserId,
    status: "connected",
    updatedAt: now,
    userId: input.userId,
  };
  await getDatabase()
    .insert(githubPullRequestAuthors)
    .values({ ...values, organizationId: input.organizationId })
    .onConflictDoUpdate({ target: githubPullRequestAuthors.organizationId, set: values });
}

export async function removeGitHubPullRequestAuthor(organizationId: string): Promise<boolean> {
  const rows = await getDatabase()
    .delete(githubPullRequestAuthors)
    .where(eq(githubPullRequestAuthors.organizationId, organizationId))
    .returning({ organizationId: githubPullRequestAuthors.organizationId });
  return rows.length > 0;
}

// Stops using the member's token until a member connects again.
export async function markGitHubPullRequestAuthorRejected(organizationId: string): Promise<void> {
  await getDatabase()
    .update(githubPullRequestAuthors)
    .set({ status: "error", updatedAt: new Date() })
    .where(eq(githubPullRequestAuthors.organizationId, organizationId));
}

export interface GitHubPullRequestAuthorToken {
  githubLogin: string;
  token: string;
}

// The member's token, refreshed first when it is about to expire. Null when
// no member is set, the member left the workspace, or GitHub rejected the
// token. A refresh token works once, so the row stays locked while it is
// exchanged and concurrent callers wait for the new token.
export async function githubPullRequestAuthorToken(
  organizationId: string,
  options: {
    now?: Date;
    refresh?: typeof refreshGitHubUserToken;
  } = {},
): Promise<GitHubPullRequestAuthorToken | null> {
  const now = options.now ?? new Date();
  const refresh = options.refresh ?? refreshGitHubUserToken;
  return getDatabase().transaction(async (tx) => {
    const rows = await tx
      .select({
        encryptedCredentials: githubPullRequestAuthors.encryptedCredentials,
        githubLogin: githubPullRequestAuthors.githubLogin,
        status: githubPullRequestAuthors.status,
      })
      .from(githubPullRequestAuthors)
      .innerJoin(member, and(
        eq(member.organizationId, githubPullRequestAuthors.organizationId),
        eq(member.userId, githubPullRequestAuthors.userId),
      ))
      .where(eq(githubPullRequestAuthors.organizationId, organizationId))
      .limit(1)
      .for("update", { of: githubPullRequestAuthors });
    const row = rows[0];
    if (!row || row.status !== "connected") return null;
    const credentials = decryptCredentials<GitHubUserCredentials>(row.encryptedCredentials);
    if (!githubUserCredentialsNeedRefresh(credentials, now)) {
      return { githubLogin: row.githubLogin, token: credentials.accessToken };
    }
    try {
      const refreshed = await refresh(credentials, { now });
      await tx
        .update(githubPullRequestAuthors)
        .set({ encryptedCredentials: encryptCredentials(refreshed), updatedAt: now })
        .where(eq(githubPullRequestAuthors.organizationId, organizationId));
      return { githubLogin: row.githubLogin, token: refreshed.accessToken };
    } catch (error) {
      if (error instanceof GitHubUserTokenRejectedError) {
        await tx
          .update(githubPullRequestAuthors)
          .set({ status: "error", updatedAt: now })
          .where(eq(githubPullRequestAuthors.organizationId, organizationId));
        return null;
      }
      // GitHub may be briefly unavailable. The current token still works
      // until it expires.
      if (!githubUserCredentialsExpired(credentials, now)) {
        return { githubLogin: row.githubLogin, token: credentials.accessToken };
      }
      throw error;
    }
  });
}

// Recorded before the branch is created, so the branch is known before
// GitHub reports the pull request.
export async function recordMemberPullRequestBranch(input: {
  branch: string;
  organizationId: string;
  repositoryFullName: string;
}): Promise<void> {
  await getDatabase()
    .insert(githubMemberPullRequestBranches)
    .values({
      branch: input.branch,
      organizationId: input.organizationId,
      repositoryFullName: input.repositoryFullName.toLowerCase(),
    })
    .onConflictDoNothing();
}

export async function isMemberPullRequestBranch(input: {
  branch: string;
  repositoryFullName: string;
}): Promise<boolean> {
  const rows = await getDatabase()
    .select({ branch: githubMemberPullRequestBranches.branch })
    .from(githubMemberPullRequestBranches)
    .where(and(
      eq(githubMemberPullRequestBranches.repositoryFullName, input.repositoryFullName.toLowerCase()),
      eq(githubMemberPullRequestBranches.branch, input.branch),
    ))
    .limit(1);
  return rows.length > 0;
}
