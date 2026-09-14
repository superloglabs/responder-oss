import {
  MCPServerStreamableHttp,
  type CallToolResultContent,
  type MCPCallToolOptions,
  type MCPServer,
} from "@openai/agents";
import type { RuntimeSupabaseConnection } from "@responder/core/db/investigations";
import { safeCustomMcpFetch } from "@responder/core/integrations/custom-mcp";
import { supabaseAllowedTools } from "@responder/core/integrations/supabase";

export class ScopedSupabaseMcpServer implements MCPServer {
  readonly cacheToolsList = true;
  readonly name: string;
  readonly useStructuredContent = true;
  private readonly allowedTools: ReadonlySet<string>;

  constructor(
    private readonly server: MCPServer,
    connection: RuntimeSupabaseConnection,
  ) {
    this.name = `supabase-${connection.accountId}`;
    this.allowedTools = new Set(supabaseAllowedTools(connection.accessMode));
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
    if (!this.allowedTools.has(toolName)) {
      throw new Error(
        `Supabase tool ${toolName} is not available for this connection`,
      );
    }
    return this.server.callTool(toolName, args, meta, options);
  }

  invalidateToolsCache(): Promise<void> {
    return this.server.invalidateToolsCache();
  }
}

export function createSupabaseMcpServer(
  connection: RuntimeSupabaseConnection,
): MCPServer {
  const allowedToolNames = [...supabaseAllowedTools(connection.accessMode)];
  const server = new MCPServerStreamableHttp({
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 300,
    fetch: safeCustomMcpFetch,
    name: `supabase-upstream-${connection.accountId}`,
    requestInit: {
      headers: { authorization: `Bearer ${connection.accessToken}` },
    },
    timeout: 30_000,
    toolFilter: { allowedToolNames },
    url: connection.mcpUrl,
    useStructuredContent: true,
  });
  return new ScopedSupabaseMcpServer(server, connection);
}
