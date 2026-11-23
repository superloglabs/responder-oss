import { and, eq, exists, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDatabase } from "./client.js";
import { integrationAccounts, repositories } from "./schema.js";

// The GitHub IDs a webhook gives for the repository it is about. A
// repository's full name can pass to another owner after a rename; these IDs
// cannot.
export interface GitHubRepositoryIds {
  installationId: number;
  repositoryId: number;
}

// True when the workspace still holds the GitHub installation and the
// repository a webhook names: the connection is connected and the repository
// available. Pull requests are recorded by full name, so this keeps another
// owner's repository of the same name from matching them.
export function workspaceHoldsGitHubRepository(
  organizationId: AnyPgColumn,
  ids: GitHubRepositoryIds,
): SQL {
  return exists(
    getDatabase()
      .select({ held: sql`1` })
      .from(repositories)
      .innerJoin(
        integrationAccounts,
        eq(integrationAccounts.id, repositories.integrationAccountId),
      )
      .where(and(
        eq(integrationAccounts.organizationId, organizationId),
        eq(integrationAccounts.provider, "github"),
        eq(integrationAccounts.externalAccountId, String(ids.installationId)),
        eq(integrationAccounts.status, "connected"),
        eq(repositories.externalId, String(ids.repositoryId)),
        eq(repositories.available, true),
      )),
  );
}
