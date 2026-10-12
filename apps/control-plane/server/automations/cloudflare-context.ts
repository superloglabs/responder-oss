import { isCloudflareContextTool } from "../../../../packages/core/src/integrations/cloudflare.js";
import type { ManagedMcpServer } from "./managed-mcp-context.js";

// Automation runs reach Cloudflare's hosted API MCP server through the broker
// with the same tools as investigations: the API, docs, and identity tools.
// The connection's read-only OAuth grant limits what the API tool can do.

/** Cloudflare's hosted MCP server as the broker reaches it for a connection. */
export function cloudflareContextServer(input: {
  accessToken: () => Promise<string>;
  accountId: string;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  mcpUrl: string;
  now: () => number;
}): ManagedMcpServer {
  return {
    cacheKey: `cloudflare:${input.accountId}`,
    fetch: input.fetch,
    headers: async () => new Headers({
      authorization: `Bearer ${await input.accessToken()}`,
    }),
    isAllowed: isCloudflareContextTool,
    label: "Cloudflare MCP",
    now: input.now,
    url: input.mcpUrl,
  };
}
