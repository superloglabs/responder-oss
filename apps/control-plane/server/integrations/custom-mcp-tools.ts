import { Hono } from "hono";
import { z } from "zod";
import {
  decryptCredentials,
  encryptCredentials,
} from "../../../../packages/core/src/credentials/encryption.js";
import {
  getOrganizationIntegrationAccount,
  setCustomMcpAllowedTools,
  withIntegrationAccountCredentialLease,
} from "../../../../packages/core/src/db/integrations.js";
import {
  customMcpAllowedTools,
  customMcpAllowedToolsSchema,
  listCustomMcpToolSummaries,
  McpOAuthRefreshError,
  parseCustomMcpCredentials,
  refreshCustomMcpOAuth,
  type CustomMcpCredentials,
} from "../../../../packages/core/src/integrations/custom-mcp.js";
import { getActiveTenant } from "../tenant.js";
import { integrationCallbackUrl } from "./urls.js";

// Lets a workspace choose which of a custom MCP server's tools agents may use.
// The list lives in the connection's metadata, and the worker and automation
// context broker enforce it.

const accountIdSchema = z.uuid();
const updateSchema = z.object({
  allowedTools: customMcpAllowedToolsSchema.nullable(),
});

async function customMcpAccessToken(input: {
  integrationAccountId: string;
  organizationId: string;
}): Promise<string> {
  const credentials = await withIntegrationAccountCredentialLease<CustomMcpCredentials>({
    allowedStatuses: ["connected"],
    integrationAccountId: input.integrationAccountId,
    operation: async (encryptedCredentials) => {
      const current = parseCustomMcpCredentials(
        decryptCredentials<Record<string, unknown>>(encryptedCredentials),
      );
      if (current.authType === "api_token") return { value: current };
      const oauth = await refreshCustomMcpOAuth({
        mcpUrl: current.mcpUrl,
        oauth: current.oauth,
        redirectUrl: integrationCallbackUrl("custom_mcp"),
      });
      if (oauth === current.oauth) return { value: current };
      const updated = { ...current, oauth };
      return {
        encryptedCredentials: encryptCredentials(updated),
        value: updated,
      };
    },
    organizationId: input.organizationId,
    provider: "custom_mcp",
  });
  const accessToken = credentials?.authType === "api_token"
    ? credentials.apiToken
    : credentials?.oauth.tokens?.access_token;
  if (!accessToken) throw new McpOAuthRefreshError(true);
  return accessToken;
}

export const customMcpToolRoutes = new Hono()
  .get("/:integrationAccountId/tools", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const accountId = accountIdSchema.safeParse(context.req.param("integrationAccountId"));
    if (!accountId.success) {
      return context.json({ error: "The MCP connection is invalid" }, 400);
    }
    const account = await getOrganizationIntegrationAccount({
      integrationAccountId: accountId.data,
      organizationId: tenant.organizationId,
      provider: "custom_mcp",
    });
    if (!account?.encryptedCredentials) {
      return context.json({ error: "MCP connection not found" }, 404);
    }
    if (account.status !== "connected") {
      return context.json({ error: "Reconnect this MCP server to see its tools" }, 409);
    }
    const allowedTools = customMcpAllowedTools(account.metadata);
    try {
      const { mcpUrl } = parseCustomMcpCredentials(
        decryptCredentials<Record<string, unknown>>(account.encryptedCredentials),
      );
      const tools = await listCustomMcpToolSummaries({
        accessToken: await customMcpAccessToken({
          integrationAccountId: accountId.data,
          organizationId: tenant.organizationId,
        }),
        mcpUrl,
      });
      return context.json({ allowedTools, tools });
    } catch (error) {
      console.error(JSON.stringify({
        accountId: accountId.data,
        errorType: error instanceof Error ? error.name : typeof error,
        event: "custom_mcp_tool_list_failed",
        organizationId: tenant.organizationId,
      }));
      return context.json({
        error: error instanceof McpOAuthRefreshError && error.reconnectRequired
          ? "Reconnect this MCP server to see its tools"
          : "Unable to list this MCP server's tools",
      }, 502);
    }
  })
  .put("/:integrationAccountId/tools", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const accountId = accountIdSchema.safeParse(context.req.param("integrationAccountId"));
    const parsed = updateSchema.safeParse(await context.req.json().catch(() => null));
    if (!accountId.success || !parsed.success) {
      return context.json({ error: "Choose the tools agents may use" }, 400);
    }
    const allowedTools = parsed.data.allowedTools
      ? [...new Set(parsed.data.allowedTools)].sort()
      : null;
    const updated = await setCustomMcpAllowedTools({
      allowedTools,
      integrationAccountId: accountId.data,
      organizationId: tenant.organizationId,
    });
    if (!updated) {
      return context.json({ error: "MCP connection not found" }, 404);
    }
    return context.json({ allowedTools });
  });
