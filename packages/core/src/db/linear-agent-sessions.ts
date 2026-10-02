import { and, desc, eq } from "drizzle-orm";
import {
  decryptCredentials,
  encryptCredentials,
} from "../credentials/encryption.js";
import {
  linearAccessTokenNeedsRefresh,
  parseLinearOAuthCredentials,
  refreshLinearOAuthCredentials,
} from "../integrations/linear.js";
import {
  createLinearAgentActivity,
  type LinearAgentActivityContent,
} from "../integrations/linear-agent.js";
import { getDatabase } from "./client.js";
import { withIntegrationAccountCredentialLease } from "./integrations.js";
import { agents, integrationAccounts } from "./schema.js";

export interface LinearAgentTarget {
  integrationAccountId: string;
  organizationId: string;
  // Linear mentions run as tag mode. Null when the workspace has not set
  // it up.
  tagMode: { agentId: string; enabled: boolean } | null;
}

// A Linear workspace can be connected to more than one Responder workspace,
// but Linear opens a single agent session per mention. The most recent
// connection answers it.
export async function findLinearAgentTarget(
  linearOrganizationId: string,
): Promise<LinearAgentTarget | null> {
  const rows = await getDatabase()
    .select({
      integrationAccountId: integrationAccounts.id,
      organizationId: integrationAccounts.organizationId,
      agentId: agents.id,
      agentEnabled: agents.enabled,
    })
    .from(integrationAccounts)
    .leftJoin(
      agents,
      and(
        eq(agents.organizationId, integrationAccounts.organizationId),
        eq(agents.purpose, "slack_thread"),
      ),
    )
    .where(
      and(
        eq(integrationAccounts.provider, "linear"),
        eq(integrationAccounts.externalAccountId, linearOrganizationId),
        eq(integrationAccounts.status, "connected"),
      ),
    )
    .orderBy(desc(integrationAccounts.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    integrationAccountId: row.integrationAccountId,
    organizationId: row.organizationId,
    tagMode: row.agentId
      ? { agentId: row.agentId, enabled: row.agentEnabled === true }
      : null,
  };
}

// Refreshes the token under the credential lease, because Linear rotates the
// refresh token on every refresh.
export async function linearAccountAccessToken(input: {
  integrationAccountId: string;
  organizationId: string;
}): Promise<string | null> {
  const credentials = await withIntegrationAccountCredentialLease({
    allowedStatuses: ["connected"],
    integrationAccountId: input.integrationAccountId,
    operation: async (encryptedCredentials) => {
      const current = parseLinearOAuthCredentials(
        decryptCredentials<Record<string, unknown>>(encryptedCredentials),
      );
      if (!linearAccessTokenNeedsRefresh(current)) return { value: current };
      const updated = await refreshLinearOAuthCredentials({
        credentials: current,
      });
      return {
        encryptedCredentials: encryptCredentials(updated),
        value: updated,
      };
    },
    organizationId: input.organizationId,
    provider: "linear",
  });
  return credentials?.accessToken ?? null;
}

export async function sendLinearAgentActivity(input: {
  agentSessionId: string;
  content: LinearAgentActivityContent;
  ephemeral?: boolean;
  id?: string;
  integrationAccountId: string;
  organizationId: string;
}): Promise<void> {
  const accessToken = await linearAccountAccessToken(input);
  if (!accessToken) throw new Error("The Linear connection is unavailable");
  await createLinearAgentActivity({
    accessToken,
    agentSessionId: input.agentSessionId,
    content: input.content,
    ephemeral: input.ephemeral,
    id: input.id,
  });
}
