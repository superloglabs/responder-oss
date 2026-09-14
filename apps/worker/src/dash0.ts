import { MCPServerStreamableHttp } from "@openai/agents";
import type { RuntimeDash0Connection } from "@responder/core/db/investigations";
import { safeCustomMcpFetch } from "@responder/core/integrations/custom-mcp";

const DASH0_DELEGATION_TOOLS = new Set([
  "getAgent0ThreadContent",
  "getAgent0ThreadStatus",
  "listAgent0Threads",
  "runTask",
  "waitForTask",
]);

export function dash0ReadOnlyToolFilter(
  _context: unknown,
  tool: unknown,
): Promise<boolean> {
  const candidate = tool as {
    annotations?: { readOnlyHint?: unknown };
    name?: unknown;
  };
  return Promise.resolve(
    typeof candidate.name === "string" &&
      !DASH0_DELEGATION_TOOLS.has(candidate.name) &&
      candidate.annotations?.readOnlyHint === true,
  );
}

export function createDash0McpServer(
  connection: RuntimeDash0Connection,
): MCPServerStreamableHttp {
  return new MCPServerStreamableHttp({
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 300,
    fetch: safeCustomMcpFetch,
    name: `dash0-${connection.accountId}`,
    requestInit: {
      headers: { authorization: `Bearer ${connection.accessToken}` },
    },
    timeout: 30_000,
    toolFilter: dash0ReadOnlyToolFilter,
    url: connection.mcpUrl,
    useStructuredContent: true,
  });
}
