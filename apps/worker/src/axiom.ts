import { MCPServerStreamableHttp } from "@openai/agents";
import type { RuntimeAxiomConnection } from "@responder/core/db/investigations";
import { safeCustomMcpFetch } from "@responder/core/integrations/custom-mcp";

export const AXIOM_READ_ONLY_MCP_TOOLS = [
  "checkMonitors",
  "exportDashboard",
  "getDashboard",
  "getDatasetSchema",
  "getMetricTagValues",
  "getMonitorHistory",
  "getSavedQueries",
  "listDashboards",
  "listDatasets",
  "listMetricTags",
  "listMetrics",
  "listNotifiers",
  "queryApl",
  "queryMetrics",
  "searchMetrics",
] as const;

export function axiomReadOnlyToolFilter(
  _context: unknown,
  tool: unknown,
): Promise<boolean> {
  const name = (tool as { name?: unknown }).name;
  return Promise.resolve(
    typeof name === "string" &&
      (AXIOM_READ_ONLY_MCP_TOOLS as readonly string[]).includes(name),
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
