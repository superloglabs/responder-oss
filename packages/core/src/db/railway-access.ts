import { decryptCredentials, encryptCredentials } from "../credentials/encryption.js";
import { McpOAuthRefreshError, refreshCustomMcpOAuth } from "../integrations/custom-mcp.js";
import {
  assertRailwayGrant,
  parseRailwayCredentials,
  RAILWAY_API_ORIGIN,
  railwayAccessTokenIsFresh,
  withRailwayGrantScope,
} from "../integrations/railway.js";
import { withIntegrationAccountCredentialLease } from "./integrations.js";
import { mcpOAuthRedirectUrl } from "./investigations.js";

export interface RailwayAccessDependencies {
  now: () => number;
  refresh: typeof refreshCustomMcpOAuth;
  withCredentialLease: typeof withIntegrationAccountCredentialLease;
}

const defaultDependencies: RailwayAccessDependencies = {
  now: Date.now,
  refresh: refreshCustomMcpOAuth,
  withCredentialLease: withIntegrationAccountCredentialLease,
};

/**
 * A Railway connection's access token for code that reads Railway outside a
 * run, such as the log reader and the environment picker. Railway access
 * tokens last an hour, so one is refreshed only when it is about to expire.
 * Refresh tokens rotate, and the lease stores the new one before another
 * reader can use the old one. Null when the connection is gone or no longer
 * connected; throws McpOAuthRefreshError when Railway refuses the refresh.
 */
export async function railwayAccessToken(
  input: { integrationAccountId: string; organizationId: string },
  dependencies: RailwayAccessDependencies = defaultDependencies,
): Promise<string | null> {
  const credentials = await dependencies.withCredentialLease({
    allowedStatuses: ["connected"],
    integrationAccountId: input.integrationAccountId,
    operation: async (encryptedCredentials) => {
      const current = parseRailwayCredentials(decryptCredentials<Record<string, unknown>>(encryptedCredentials));
      const now = dependencies.now();
      if (railwayAccessTokenIsFresh(current, now)) return { value: current };
      const oauth = withRailwayGrantScope(
        current.oauth,
        await dependencies.refresh({
          mcpUrl: RAILWAY_API_ORIGIN,
          oauth: current.oauth,
          redirectUrl: mcpOAuthRedirectUrl("railway"),
        }),
      );
      if (oauth === current.oauth) return { value: current };
      // A refreshed grant with more access than chosen is never stored.
      assertRailwayGrant(oauth.tokens, current.accessLevel);
      const updated = { ...current, oauth, tokenIssuedAt: now };
      return { encryptedCredentials: encryptCredentials(updated), value: updated };
    },
    organizationId: input.organizationId,
    provider: "railway",
  });
  if (!credentials) return null;
  const accessToken = credentials.oauth.tokens?.access_token;
  if (typeof accessToken !== "string" || !accessToken) throw new McpOAuthRefreshError(true);
  assertRailwayGrant(credentials.oauth.tokens, credentials.accessLevel);
  return accessToken;
}
