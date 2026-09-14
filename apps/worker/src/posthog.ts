import { MCPServerStreamableHttp } from "@openai/agents";
import type { RuntimePostHogConnection } from "@responder/core/db/investigations";
import { safeCustomMcpFetch } from "@responder/core/integrations/custom-mcp";

export function postHogReadOnlyToolFilter(
  _context: unknown,
  tool: unknown,
): Promise<boolean> {
  const candidate = tool as {
    annotations?: { readOnlyHint?: unknown };
    name?: unknown;
  };
  return Promise.resolve(
    typeof candidate.name === "string" &&
      candidate.annotations?.readOnlyHint === true,
  );
}

export function createPostHogMcpServer(
  connection: RuntimePostHogConnection,
): MCPServerStreamableHttp {
  return new MCPServerStreamableHttp({
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 300,
    fetch: safeCustomMcpFetch,
    name: `posthog-${connection.accountId}`,
    requestInit: {
      headers: { authorization: `Bearer ${connection.accessToken}` },
    },
    timeout: 30_000,
    toolFilter: postHogReadOnlyToolFilter,
    url: connection.mcpUrl,
    useStructuredContent: true,
  });
}
