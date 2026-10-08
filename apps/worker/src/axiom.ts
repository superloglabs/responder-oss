import { MCPServerStreamableHttp } from "@openai/agents";
import type { RuntimeAxiomConnection } from "@responder/core/db/investigations";
import { isAxiomReadOnlyTool } from "@responder/core/integrations/axiom";
import { safeCustomMcpFetch } from "@responder/core/integrations/custom-mcp";

export { AXIOM_READ_ONLY_MCP_TOOLS } from "@responder/core/integrations/axiom";

export function axiomReadOnlyToolFilter(
  _context: unknown,
  tool: unknown,
): Promise<boolean> {
  const name = (tool as { name?: unknown }).name;
  return Promise.resolve(
    typeof name === "string" && isAxiomReadOnlyTool(name),
  );
}

export function createAxiomMcpServer(
  connection: RuntimeAxiomConnection,
): MCPServerStreamableHttp {
  return new MCPServerStreamableHttp({
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 300,
    fetch: safeCustomMcpFetch,
    name: "axiom",
    requestInit: {
      headers: { authorization: `Bearer ${connection.accessToken}` },
    },
    timeout: 30_000,
    toolFilter: axiomReadOnlyToolFilter,
    url: connection.mcpUrl,
    useStructuredContent: true,
  });
}
