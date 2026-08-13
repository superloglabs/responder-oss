import { MCPServerStreamableHttp } from "@openai/agents";
import type { RuntimeClickStackConnection } from "@responder/core/db/investigations";
import { safeCustomMcpFetch } from "@responder/core/integrations/custom-mcp";

export function clickStackMcpHeaders(
  connection: RuntimeClickStackConnection,
): Record<string, string> {
  if (connection.authType === "access_key") {
    return { authorization: `Bearer ${connection.accessKey}` };
  }
  return {
    authorization: `Bearer ${connection.accessToken}`,
    "x-service-id": connection.serviceId,
  };
}

export function createClickStackMcpServer(
  connection: RuntimeClickStackConnection,
): MCPServerStreamableHttp {
  return new MCPServerStreamableHttp({
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 300,
    fetch: safeCustomMcpFetch,
    name: "clickstack",
    requestInit: {
      headers: clickStackMcpHeaders(connection),
    },
    timeout: 30_000,
    url: connection.mcpUrl,
    useStructuredContent: true,
  });
}
