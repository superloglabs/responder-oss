import {
  MCPServerStreamableHttp,
  type MCPCallToolOptions,
  type MCPServer,
} from "@openai/agents";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { RuntimeSlackConnection } from "@responder/core/db/investigations";
import {
  SLACK_CONTEXT_MCP_TOOLS,
  slackContextToolAccess,
} from "@responder/core/integrations/slack-mcp";

export class ScopedSlackMcpServer implements MCPServer {
  readonly cacheToolsList = true;
  readonly name: string;
  readonly useStructuredContent = true;
  private readonly allowedChannelIds: ReadonlySet<string>;

  constructor(
    private readonly server: MCPServer,
    connection: RuntimeSlackConnection,
  ) {
    this.name = `slack-${connection.accountId}`;
    this.allowedChannelIds = new Set(
      connection.channels.map((channel) => channel.id),
    );
  }

  connect(): Promise<void> {
    return this.server.connect();
  }

  close(): Promise<void> {
    return this.server.close();
  }

  async listTools(): ReturnType<MCPServer["listTools"]> {
    const tools = await this.server.listTools();
    return tools.filter((tool) =>
      (SLACK_CONTEXT_MCP_TOOLS as readonly string[]).includes(tool.name),
    );
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ) {
    const access = slackContextToolAccess({
      allowedChannelIds: this.allowedChannelIds,
      args,
      toolName,
    });
    if (!access.allowed) {
      const error = new Error(access.reason);
      const span = trace.getActiveSpan();
      span?.recordException(error);
      span?.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      console.error(
        JSON.stringify({
          event: "slack_mcp_tool_blocked",
          reason: access.reason,
          serverName: this.name,
          toolName,
        }),
      );
      throw error;
    }
    return this.server.callTool(toolName, args, meta, options);
  }

  invalidateToolsCache(): Promise<void> {
    return this.server.invalidateToolsCache();
  }
}

export function createSlackMcpServer(
  connection: RuntimeSlackConnection,
): MCPServer {
  const server = new MCPServerStreamableHttp({
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 300,
    name: "slack-upstream",
    requestInit: {
      headers: { authorization: `Bearer ${connection.userAccessToken}` },
    },
    timeout: 30_000,
    url: connection.mcpUrl,
    useStructuredContent: true,
  });
  return new ScopedSlackMcpServer(server, connection);
}
