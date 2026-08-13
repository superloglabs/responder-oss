import { MCPServerStreamableHttp } from "@openai/agents";
import type { RuntimeDatadogConnection } from "@responder/core/db/investigations";

export function datadogMcpHeaders(
  connection: RuntimeDatadogConnection,
): Record<string, string> {
  return connection.authType === "api_keys"
    ? {
        "dd-api-key": connection.apiKey,
        "dd-application-key": connection.applicationKey,
      }
    : {
        authorization: `Bearer ${connection.accessToken}`,
      };
}

export function createDatadogMcpServer(
  connection: RuntimeDatadogConnection,
): MCPServerStreamableHttp {
  return new MCPServerStreamableHttp({
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 300,
    name: "datadog",
    requestInit: {
      headers: datadogMcpHeaders(connection),
    },
    timeout: 30_000,
    url: connection.mcpUrl,
    useStructuredContent: true,
  });
}
