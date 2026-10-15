import { MCPServerStreamableHttp } from "@openai/agents";
import type { RuntimeAxiomConnection } from "@responder/core/db/investigations";
import { isAxiomAllowedTool } from "@responder/core/integrations/axiom";
import { safeCustomMcpFetch } from "@responder/core/integrations/custom-mcp";

export {
  AXIOM_ALERTING_MCP_TOOLS,
  AXIOM_READ_ONLY_MCP_TOOLS,
} from "@responder/core/integrations/axiom";

// Tag mode may set up Axiom alerts. Alert investigations and scans only read.
export function axiomToolFilter(access: { alerting: boolean }) {
  return (_context: unknown, tool: unknown): Promise<boolean> => {
    const name = (tool as { name?: unknown }).name;
    return Promise.resolve(
      typeof name === "string" && isAxiomAllowedTool(name, access),
    );
  };
}

export function createAxiomMcpServer(
  connection: RuntimeAxiomConnection,
  access: { alerting: boolean },
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
    toolFilter: axiomToolFilter(access),
    url: connection.mcpUrl,
    useStructuredContent: true,
  });
}
