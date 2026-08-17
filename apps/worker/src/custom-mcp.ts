import { MCPServerStreamableHttp } from "@openai/agents";
import type { RuntimeCustomMcpConnection } from "@responder/core/db/investigations";
import { safeCustomMcpFetch } from "@responder/core/integrations/custom-mcp";

export function customMcpHeaders(
  connection: RuntimeCustomMcpConnection,
): Record<string, string> {
  return { authorization: `Bearer ${connection.accessToken}` };
}

export function createCustomMcpServer(
  connection: RuntimeCustomMcpConnection,
): MCPServerStreamableHttp {
  return new MCPServerStreamableHttp({
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 300,
    fetch: safeCustomMcpFetch,
    name: `custom-mcp-${connection.accountId}`,
    requestInit: {
      headers: customMcpHeaders(connection),
    },
    timeout: 30_000,
    url: connection.mcpUrl,
    useStructuredContent: true,
  });
}
