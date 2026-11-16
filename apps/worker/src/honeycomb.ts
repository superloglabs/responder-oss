import { MCPServerStreamableHttp } from "@openai/agents";
import type { RuntimeHoneycombConnection } from "@responder/core/db/investigations";
import { honeycombAuthorization } from "@responder/core/integrations/honeycomb";
import { safeCustomMcpFetch } from "@responder/core/integrations/custom-mcp";

// Honeycomb's hosted MCP server for the team's region, with the team's
// management API key as a bearer token, as automation runs reach it through
// the context broker.
export function createHoneycombMcpServer(
  connection: RuntimeHoneycombConnection,
): MCPServerStreamableHttp {
  return new MCPServerStreamableHttp({
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 300,
    fetch: safeCustomMcpFetch,
    name: `honeycomb-${connection.accountId}`,
    requestInit: {
      headers: { authorization: honeycombAuthorization(connection) },
    },
    timeout: 30_000,
    url: connection.mcpUrl,
    useStructuredContent: true,
  });
}
