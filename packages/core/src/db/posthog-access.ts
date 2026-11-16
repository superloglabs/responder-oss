import { decryptCredentials, encryptCredentials } from "../credentials/encryption.js";
import { McpOAuthRefreshError, refreshCustomMcpOAuth } from "../integrations/custom-mcp.js";
import { parsePostHogCredentials, postHogAccessTokenIsFresh } from "../integrations/posthog.js";
import { withIntegrationAccountCredentialLease } from "./integrations.js";
import { mcpOAuthRedirectUrl } from "./investigations.js";

export interface PostHogAccessDependencies {
  now: () => number;
  refresh: typeof refreshCustomMcpOAuth;
  withCredentialLease: typeof withIntegrationAccountCredentialLease;
}

const defaultDependencies: PostHogAccessDependencies = {
  now: Date.now,
  refresh: refreshCustomMcpOAuth,
  withCredentialLease: withIntegrationAccountCredentialLease,
};

/**
 * A PostHog connection's access token for code that reads PostHog outside a
 * run, such as the log reader and the project picker. The token is refreshed
 * only when it is about to expire, and the lease stores a rotated refresh
 * token before another reader can use the old one. Null when the connection
 * is gone or no longer connected; throws McpOAuthRefreshError when PostHog
 * refuses the refresh.
 */
export async function postHogAccessToken(
  input: { integrationAccountId: string; organizationId: string },
  dependencies: PostHogAccessDependencies = defaultDependencies,
): Promise<string | null> {
  const credentials = await dependencies.withCredentialLease({
    allowedStatuses: ["connected"],
    integrationAccountId: input.integrationAccountId,
    operation: async (encryptedCredentials) => {
      const current = parsePostHogCredentials(decryptCredentials<Record<string, unknown>>(encryptedCredentials));
      const now = dependencies.now();
      if (postHogAccessTokenIsFresh(current, now)) return { value: current };
      const oauth = await dependencies.refresh({
        mcpUrl: current.mcpUrl,
        oauth: current.oauth,
        redirectUrl: mcpOAuthRedirectUrl("posthog"),
      });
      if (oauth === current.oauth) return { value: current };
      const updated = { ...current, oauth, tokenIssuedAt: now };
      return { encryptedCredentials: encryptCredentials(updated), value: updated };
    },
    organizationId: input.organizationId,
    provider: "posthog",
  });
  if (!credentials) return null;
  const accessToken = credentials.oauth.tokens?.access_token;
  if (typeof accessToken !== "string" || !accessToken) throw new McpOAuthRefreshError(true);
  return accessToken;
}
