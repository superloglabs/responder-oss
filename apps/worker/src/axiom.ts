import { MCPServerStreamableHttp } from "@openai/agents";
import type { RuntimeAxiomConnection } from "@responder/core/db/investigations";
import { isAxiomReadOnlyTool, isAxiomSavingQueryTool } from "@responder/core/integrations/axiom";
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

// Whether an Axiom tool stays available to an observer. Axiom marks its query
// tools as able to write; a read-only server calls them without saving.
export function isAxiomObservationTool(tool: { name?: string }): boolean {
  return tool.name !== undefined && isAxiomReadOnlyTool(tool.name);
}

type ListedTool = Awaited<ReturnType<MCPServerStreamableHttp["listTools"]>>[number];
type CallToolResultArgs = Parameters<MCPServerStreamableHttp["callToolResult"]>;

// A query tool's schema without saveResults, so the model is not offered it.
export function withoutSaveResults(tool: ListedTool): ListedTool {
  if (!isAxiomSavingQueryTool(tool.name)) return tool;
  const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  if (!schema.properties || !("saveResults" in schema.properties)) return tool;
  const properties = Object.fromEntries(
    Object.entries(schema.properties).filter(([name]) => name !== "saveResults"),
  );
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties,
      ...(schema.required ? { required: schema.required.filter((name) => name !== "saveResults") } : {}),
    } as ListedTool["inputSchema"],
  };
}

// A query tool's arguments with saveResults false, so the query only runs.
export function readOnlyAxiomArguments(
  name: string,
  args: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!isAxiomSavingQueryTool(name)) return args;
  return { ...(args ?? {}), saveResults: false };
}

// Calls Axiom's query tools without saving their results.
class ReadOnlyAxiomMcpServer extends MCPServerStreamableHttp {
  override async listTools(): Promise<ListedTool[]> {
    return (await super.listTools()).map(withoutSaveResults);
  }

  override callToolResult(...[name, args, ...rest]: CallToolResultArgs) {
    return super.callToolResult(name, readOnlyAxiomArguments(name, args), ...rest);
  }
}

// Tag mode may call every Axiom tool. Alert investigations and scans only read.
export function createAxiomMcpServer(
  connection: RuntimeAxiomConnection,
  access: { readOnly: boolean },
): MCPServerStreamableHttp {
  const options = {
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 300,
    fetch: safeCustomMcpFetch,
    name: "axiom",
    requestInit: {
      headers: { authorization: `Bearer ${connection.accessToken}` },
    },
    timeout: 30_000,
    url: connection.mcpUrl,
    useStructuredContent: true,
  };
  return access.readOnly
    ? new ReadOnlyAxiomMcpServer({ ...options, toolFilter: axiomReadOnlyToolFilter })
    : new MCPServerStreamableHttp(options);
}
