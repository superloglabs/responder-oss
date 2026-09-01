import { MCPServerStreamableHttp } from "@openai/agents";
import type { RuntimeGcpConnection } from "@responder/core/db/investigations";
import { createGcpAuthClient } from "@responder/core/integrations/gcp";

const GCP_MCP_SERVERS = [
  { id: "assets", url: "https://cloudasset.googleapis.com/mcp" },
  { id: "logging", url: "https://logging.googleapis.com/mcp" },
  { id: "monitoring", url: "https://monitoring.googleapis.com/mcp" },
] as const;

export function gcpReadOnlyToolFilter(
  _context: unknown,
  tool: unknown,
): Promise<boolean> {
  const candidate = tool as { annotations?: { readOnlyHint?: boolean } };
  return Promise.resolve(candidate.annotations?.readOnlyHint === true);
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

  return GCP_MCP_SERVERS.map(
    ({ id, url }) =>
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
