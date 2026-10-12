import {
  MCPServerStdio,
  MCPServerStreamableHttp,
  type MCPServer,
} from "@openai/agents";
import type { RuntimeGrafanaConnection } from "@responder/core/db/investigations";
import { safeCustomMcpFetch } from "@responder/core/integrations/custom-mcp";
import {
  grafanaSelfHostedProcess,
  isGrafanaReadOnlyTool,
} from "@responder/core/integrations/grafana-mcp";

export function grafanaReadOnlyToolFilter(
  _context: unknown,
  tool: unknown,
): Promise<boolean> {
  return Promise.resolve(isGrafanaReadOnlyTool(tool));
}

export async function createGrafanaMcpServer(
  connection: RuntimeGrafanaConnection,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<MCPServer> {
  const name = `grafana-${connection.accountId}`;
  if (connection.authType === "oauth") {
    return new MCPServerStreamableHttp({
      cacheToolsList: true,
      clientSessionTimeoutSeconds: 300,
      fetch: safeCustomMcpFetch,
      name,
      requestInit: {
        headers: { authorization: `Bearer ${connection.accessToken}` },
      },
      timeout: 30_000,
      toolFilter: grafanaReadOnlyToolFilter,
      url: connection.mcpUrl,
      useStructuredContent: true,
    });
  }

  return new MCPServerStdio({
    ...(await grafanaSelfHostedProcess(connection, environment)),
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 300,
    name,
    timeout: 30_000,
    toolFilter: grafanaReadOnlyToolFilter,
    useStructuredContent: true,
  });
}
