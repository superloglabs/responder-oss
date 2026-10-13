import { z } from "zod";
import { disableAgentsWithUnavailableRepositories } from "../../../../packages/core/src/db/agents.js";
import {
  listGitHubAccountsForInstallation,
  removeGitHubInstallationAccount,
  replaceRepositories,
  setIntegrationAccountStatus,
} from "../../../../packages/core/src/db/integrations.js";
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

  if (event.action === "deleted") {
    for (const account of accounts) {
      await removeGitHubInstallationAccount(account.id);
    }
    return "removed";
  }
  if (event.action === "suspend") {
    for (const account of accounts) {
      await setIntegrationAccountStatus(account.id, "error");
    }
    return "suspended";
  }

  const repositories = await listGitHubRepositories(event.installation.id);
  for (const account of accounts) {
    await replaceRepositories(account.id, repositories);
    await setIntegrationAccountStatus(account.id, "connected");
    await disableAgentsWithUnavailableRepositories(account.organizationId);
  }
  return "synced";
}
