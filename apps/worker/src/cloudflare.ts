import { MCPServerStreamableHttp } from "@openai/agents";
import type { RuntimeCloudflareConnection } from "@responder/core/db/investigations";
import { safeCustomMcpFetch } from "@responder/core/integrations/custom-mcp";
import { isCloudflareContextTool } from "@responder/core/integrations/cloudflare";

export function cloudflareToolFilter(
  _context: unknown,
  tool: unknown,
): Promise<boolean> {
  return Promise.resolve(isCloudflareContextTool(tool));
}

export function createCloudflareMcpServer(
  connection: RuntimeCloudflareConnection,
): MCPServerStreamableHttp {
  return new MCPServerStreamableHttp({
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 300,
    fetch: safeCustomMcpFetch,
    name: `cloudflare-${connection.accountId}`,
    requestInit: {
      headers: { authorization: `Bearer ${connection.accessToken}` },
    },
    // API calls run in Cloudflare's sandbox and can page through results.
    timeout: 60_000,
    toolFilter: cloudflareToolFilter,
    url: connection.mcpUrl,
    useStructuredContent: true,
  });
}
