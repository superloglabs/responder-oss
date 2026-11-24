import { decryptCredentials, encryptCredentials } from "../credentials/encryption.js";
import {
  jiraAccessTokenNeedsRefresh,
  jiraAuthFromCredentials,
  JiraOAuthGrantError,
  parseJiraCredentials,
  refreshJiraOAuthCredentials,
  type JiraAuth,
} from "../integrations/jira.js";
import { getOrganizationIntegrationAccount, withIntegrationAccountCredentialLease } from "./integrations.js";

// What one of the workspace's connected Jira accounts needs to make requests,
// or null when it is gone or disconnected. An OAuth access token close to
// expiry is refreshed under the credential lease, because Atlassian rotates
// the refresh token on every refresh. A refused refresh marks the connection
// as failed, since only reconnecting fixes it.
export async function jiraAccountAuth(input: {
  integrationAccountId: string;
  organizationId: string;
}): Promise<JiraAuth | null> {
  const account = await getOrganizationIntegrationAccount({ ...input, provider: "jira" });
  if (!account?.encryptedCredentials || account.status !== "connected") return null;
  const credentials = parseJiraCredentials(decryptCredentials<Record<string, unknown>>(account.encryptedCredentials));
  if (credentials.authType === "api_token" || !jiraAccessTokenNeedsRefresh(credentials)) {
    return jiraAuthFromCredentials(credentials);
  }

  const current = await withIntegrationAccountCredentialLease({
    allowedStatuses: ["connected"],
    integrationAccountId: input.integrationAccountId,
    organizationId: input.organizationId,
    provider: "jira",
    operation: async (encryptedCredentials) => {
      const stored = parseJiraCredentials(decryptCredentials<Record<string, unknown>>(encryptedCredentials));
      // Another caller may have refreshed while this one waited for the lease.
      if (stored.authType === "api_token" || !jiraAccessTokenNeedsRefresh(stored)) return { value: stored };
      const refreshed = await refreshJiraOAuthCredentials(stored);
      return { encryptedCredentials: encryptCredentials(refreshed), value: refreshed };
    },
    statusOnError: (error) => (error instanceof JiraOAuthGrantError ? "error" : undefined),
  });
  if (current) return jiraAuthFromCredentials(current);

  // No lease result: the connection was removed or changed, another caller's
  // refresh outlasted the wait, or this refresh's write-back was superseded.
  // Use what is stored now, if it is still usable.
  const latest = await getOrganizationIntegrationAccount({ ...input, provider: "jira" });
  if (!latest?.encryptedCredentials || latest.status !== "connected") return null;
  const stored = parseJiraCredentials(decryptCredentials<Record<string, unknown>>(latest.encryptedCredentials));
  if (stored.authType === "api_token" || !jiraAccessTokenNeedsRefresh(stored)) return jiraAuthFromCredentials(stored);
  throw new Error("The Jira token could not be refreshed. Try again.");
}
