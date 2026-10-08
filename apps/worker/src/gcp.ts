import { MCPServerStreamableHttp } from "@openai/agents";
import type { RuntimeGcpConnection } from "@responder/core/db/investigations";
import {
  createGcpAuthClient,
  GCP_MCP_SERVICES,
  isGcpReadOnlyMcpTool,
} from "@responder/core/integrations/gcp";

export function gcpReadOnlyToolFilter(
  _context: unknown,
  tool: unknown,
): Promise<boolean> {
  return Promise.resolve(isGcpReadOnlyMcpTool(
    tool as { annotations?: { readOnlyHint?: boolean } },
  ));
}

export function createGcpMcpServers(
  connection: RuntimeGcpConnection,
  environment: NodeJS.ProcessEnv = process.env,
): MCPServerStreamableHttp[] {
  const auth = createGcpAuthClient(connection, { environment });
  const authenticatedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const authHeaders = await auth.getRequestHeaders();
    const headers = new Headers(request.headers);
    for (const [name, value] of authHeaders) headers.set(name, value);
    headers.set("x-goog-user-project", connection.projectId);
    return fetch(request, { headers });
  };

  return Object.entries(GCP_MCP_SERVICES).map(
    ([id, url]) =>
      new MCPServerStreamableHttp({
        cacheToolsList: true,
        clientSessionTimeoutSeconds: 300,
        fetch: authenticatedFetch,
        name: `gcp-${connection.accountId}-${id}`,
        timeout: 60_000,
        toolFilter: gcpReadOnlyToolFilter,
        url,
        useStructuredContent: true,
      }),
  );
}
