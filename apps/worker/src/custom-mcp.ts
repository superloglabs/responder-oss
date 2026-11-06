import {
  MCPServerStreamableHttp,
  type CallToolResult,
  type CallToolResultContent,
  type MCPCallToolOptions,
  type MCPServer,
} from "@openai/agents";
import type { RuntimeCustomMcpConnection } from "@responder/core/db/investigations";
import { safeCustomMcpFetch } from "@responder/core/integrations/custom-mcp";
import { LINEAR_READONLY_MCP_URL } from "@responder/core/integrations/linear";

export function customMcpHeaders(
  connection: RuntimeCustomMcpConnection,
): Record<string, string> {
  return { authorization: `Bearer ${connection.accessToken}` };
}

// Hides and refuses the tools a connection does not allow. The SDK's tool
// filter only hides them from the agent's tool list.
export class ToolScopedMcpServer implements MCPServer {
  readonly cacheToolsList = true;
  readonly name: string;
  readonly useStructuredContent = true;
  private readonly allowedTools: ReadonlySet<string>;

  constructor(
    private readonly server: MCPServer,
    allowedTools: readonly string[],
  ) {
    this.name = server.name;
    this.allowedTools = new Set(allowedTools);
  }

  connect(): Promise<void> {
    return this.server.connect();
  }

  close(): Promise<void> {
    return this.server.close();
  }

  async listTools(): ReturnType<MCPServer["listTools"]> {
    const tools = await this.server.listTools();
    return tools.filter((tool) => this.allowedTools.has(tool.name));
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): Promise<CallToolResultContent> {
    this.assertAllowed(toolName);
    return this.server.callTool(toolName, args, meta, options);
  }

  async callToolResult(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): Promise<CallToolResult> {
    this.assertAllowed(toolName);
    if (this.server.callToolResult) {
      return this.server.callToolResult(toolName, args, meta, options);
    }
    return { content: await this.server.callTool(toolName, args, meta, options) };
  }

  private assertAllowed(toolName: string) {
    if (!this.allowedTools.has(toolName)) {
      throw new Error(`MCP tool ${toolName} is not allowed on this connection`);
    }
  }

  invalidateToolsCache(): Promise<void> {
    return this.server.invalidateToolsCache();
  }
}

export function createCustomMcpServer(
  connection: RuntimeCustomMcpConnection,
): MCPServer {
  const allowedTools = connection.allowedTools ?? null;
  const server = new MCPServerStreamableHttp({
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 300,
    fetch: safeCustomMcpFetch,
    name: `custom-mcp-${connection.accountId}`,
    requestInit: {
      headers: customMcpHeaders(connection),
    },
    timeout: 30_000,
    ...(allowedTools ? { toolFilter: { allowedToolNames: allowedTools } } : {}),
    url: connection.mcpUrl,
    useStructuredContent: true,
  });
  return allowedTools ? new ToolScopedMcpServer(server, allowedTools) : server;
}

export function createLinearMcpServer(
  connection: RuntimeCustomMcpConnection,
): MCPServerStreamableHttp {
  return new MCPServerStreamableHttp({
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 300,
    fetch: safeCustomMcpFetch,
    name: "linear",
    requestInit: {
      headers: customMcpHeaders(connection),
    },
    timeout: 30_000,
    url: LINEAR_READONLY_MCP_URL,
    useStructuredContent: true,
  });
}
