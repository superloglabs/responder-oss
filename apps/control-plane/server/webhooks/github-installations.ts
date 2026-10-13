import { z } from "zod";
import { disableAgentsWithUnavailableRepositories } from "../../../../packages/core/src/db/agents.js";
import {
  disconnectGitHubInstallationAccount,
  listGitHubAccountsForInstallation,
  removeGitHubInstallationAccount,
  replaceRepositories,
  setIntegrationAccountStatus,
} from "../../../../packages/core/src/db/integrations.js";
import { GitHubInstallationNotFoundError } from "../../../../packages/core/src/integrations/github.js";
import { listGitHubRepositories } from "../integrations/github.js";

export const githubInstallationEventSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int().positive() }),
});

export type GitHubInstallationOutcome =
  | "ignored"
  | "not_ours"
  | "removed"
  | "suspended"
  | "synced";

type GitHubConnection = { id: string; organizationId: string };

// Applies a change to every connection that uses the installation, then pauses
// agents that lost a repository. One failing connection does not stop the
// others; the first failure is raised afterwards so GitHub retries the event.
async function forEachConnection(
  accounts: GitHubConnection[],
  apply: (account: GitHubConnection) => Promise<unknown>,
): Promise<void> {
  const results = await Promise.allSettled(accounts.map(apply));
  for (const organizationId of new Set(accounts.map((account) => account.organizationId))) {
    await disableAgentsWithUnavailableRepositories(organizationId);
  }
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

// Keeps connections in step with changes people make to the GitHub App on
// GitHub: uninstalling it, suspending it, or changing which repositories it
// can access.
export async function syncGitHubInstallation(
  eventType: "installation" | "installation_repositories",
  event: z.infer<typeof githubInstallationEventSchema>,
): Promise<GitHubInstallationOutcome> {
  const resync =
    eventType === "installation_repositories" ||
    event.action === "unsuspend" ||
    event.action === "new_permissions_accepted";
  if (event.action !== "deleted" && event.action !== "suspend" && !resync) {
    return "ignored";
  }

  const accounts = await listGitHubAccountsForInstallation(event.installation.id);
  if (accounts.length === 0) return "not_ours";

  const remove = () =>
    forEachConnection(accounts, (account) => removeGitHubInstallationAccount(account.id));
  if (event.action === "deleted") {
    await remove();
    return "removed";
  }
  if (event.action === "suspend") {
    await forEachConnection(accounts, (account) =>
      disconnectGitHubInstallationAccount(account.id),
    );
    return "suspended";
  }

  let repositories;
  try {
    repositories = await listGitHubRepositories(event.installation.id);
  } catch (error) {
    // The app was uninstalled before this event arrived.
    if (!(error instanceof GitHubInstallationNotFoundError)) throw error;
    await remove();
    return "removed";
  }
  await forEachConnection(accounts, async (account) => {
    await replaceRepositories(account.id, repositories);
    await setIntegrationAccountStatus(account.id, "connected");
  });
  return "synced";
}
