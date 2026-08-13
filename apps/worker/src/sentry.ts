import { MCPServerStreamableHttp } from "@openai/agents";
import type { RuntimeSentryConnection } from "@responder/core/db/investigations";

export function sentryMcpHeaders(
  connection: RuntimeSentryConnection,
): Record<string, string> {
  return {
    authorization: `Sentry-Bearer ${connection.accessToken}`,
  };
}

export function createSentryMcpServer(
  connection: RuntimeSentryConnection,
): MCPServerStreamableHttp {
  return new MCPServerStreamableHttp({
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 300,
    name: "sentry",
    requestInit: {
      headers: sentryMcpHeaders(connection),
    },
    timeout: 30_000,
    url: connection.mcpUrl,
    useStructuredContent: true,
  });
}
