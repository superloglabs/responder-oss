import { z } from "zod";
import { callCustomMcpTool } from "@responder/core/integrations/custom-mcp";
import {
  cloudflareAccountsSchema,
  type CloudflareAccount,
} from "@responder/core/integrations/cloudflare";

const whoamiSchema = z.object({
  email: z.string().optional(),
  id: z.string().regex(/^(?:user|account):\S+$/u),
});

// Runs in Cloudflare's sandbox through the MCP server's API tool. It only
// reads, and the read-only grant is checked before this runs.
const listAccountsCode = `async () => {
  const response = await cloudflare.request({ method: "GET", path: "/accounts?per_page=50" });
  return (response.result ?? []).map((account) => ({ id: account.id, name: account.name }));
}`;

/**
 * Names a new Cloudflare connection. The Cloudflare user (or account, for an
 * account token) is the connection's identity, so reconnecting the same user
 * updates its connection. The accounts it can reach are kept for display and
 * for the agent, which passes their IDs to the API tool.
 */
export async function cloudflareConnectionProfile(
  input: { accessToken: string; mcpUrl: string },
  callTool: typeof callCustomMcpTool = callCustomMcpTool,
): Promise<{
  accounts: CloudflareAccount[];
  displayName: string;
  email?: string;
  externalAccountId: string;
}> {
  const whoami = whoamiSchema.parse(
    await callTool({ ...input, name: "whoami" }),
  );
  let accounts: CloudflareAccount[] = [];
  try {
    accounts = cloudflareAccountsSchema.parse(
      await callTool({ ...input, arguments: { code: listAccountsCode }, name: "execute" }),
    );
  } catch (error) {
    // The agent can still list accounts itself; only the label is less specific.
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : "Unknown error",
      event: "cloudflare_account_listing_failed",
    }));
  }
  const [onlyAccount] = accounts;
  const displayName = accounts.length === 1 && onlyAccount?.name
    ? onlyAccount.name
    : whoami.email
      ? accounts.length > 1
        ? `${whoami.email} · ${accounts.length} accounts`
        : whoami.email
      : "Cloudflare";
  return {
    accounts,
    displayName,
    ...(whoami.email ? { email: whoami.email } : {}),
    externalAccountId: whoami.id,
  };
}
