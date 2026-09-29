import type {
  CallToolResult,
  CallToolResultContent,
  MCPCallToolOptions,
  MCPServer,
  MCPToolFilterCallable,
  MCPToolFilterContext,
  MCPToolFilterStatic,
} from "@openai/agents";

type McpTool = Awaited<ReturnType<MCPServer["listTools"]>>[number];

export const RECONNECT_TOOL = "reconnect";

const MAX_ERROR_LENGTH = 500;

async function allowedByFilter(
  filter: MCPToolFilterCallable | MCPToolFilterStatic,
  context: MCPToolFilterContext,
  tool: McpTool,
): Promise<boolean> {
  if (typeof filter === "function") return filter(context, tool);
  const allowed = filter.allowedToolNames ?? [];
  const blocked = filter.blockedToolNames ?? [];
  return (
    (allowed.length === 0 || allowed.includes(tool.name)) &&
    !blocked.includes(tool.name)
  );
}

/**
 * Keeps a context server from failing the investigation when it is
 * unreachable. While it is down, the agent sees the error and a single
 * reconnect tool, and decides whether retrying is worth it.
 */
export class RecoverableMcpServer implements MCPServer {
  // The SDK lists tools before every turn; this class caches them itself so a
  // reconnect can replace the placeholder tool.
  readonly cacheToolsList = false;
  readonly name: string;
  readonly useStructuredContent: boolean | undefined;
  readonly toolFilter: MCPToolFilterCallable | undefined;
  readonly toolMetaResolver: MCPServer["toolMetaResolver"];
  readonly customDataExtractor: MCPServer["customDataExtractor"];
  readonly errorFunction: MCPServer["errorFunction"];
  private placeholder: McpTool | null = null;
  private tools: McpTool[] | null = null;
  private unavailableReason: string | null = null;

  constructor(
    private readonly server: MCPServer,
    private readonly describeError: (error: unknown) => string,
  ) {
    this.name = server.name;
    this.useStructuredContent = server.useStructuredContent;
    this.toolMetaResolver = server.toolMetaResolver;
    this.customDataExtractor = server.customDataExtractor;
    this.errorFunction = server.errorFunction;
    // The server's own filter still decides which real tools are exposed.
    const filter = server.toolFilter;
    this.toolFilter = filter
      ? async (context, tool) =>
          tool === this.placeholder || allowedByFilter(filter, context, tool)
      : undefined;
  }

  get available(): boolean {
    return this.unavailableReason === null;
  }

  connect(): Promise<void> {
    return this.server.connect();
  }

  close(): Promise<void> {
    return this.server.close();
  }

  markUnavailable(error: unknown): void {
    this.tools = null;
    this.unavailableReason = this.describeError(error).slice(0, MAX_ERROR_LENGTH);
  }

  async listTools(): Promise<McpTool[]> {
    if (this.unavailableReason === null && this.tools === null) {
      try {
        this.tools = await this.server.listTools();
      } catch (error) {
        this.markUnavailable(error);
      }
    }
    if (this.unavailableReason !== null) {
      this.placeholder = this.reconnectTool();
      return [this.placeholder];
    }
    return this.tools ?? [];
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): Promise<CallToolResultContent> {
    if (this.unavailableReason !== null) {
      return (await this.reconnect(toolName)).content;
    }
    return this.server.callTool(toolName, args, meta, options);
  }

  async callToolResult(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): Promise<CallToolResult> {
    if (this.unavailableReason !== null) return this.reconnect(toolName);
    if (this.server.callToolResult) {
      return this.server.callToolResult(toolName, args, meta, options);
    }
    return { content: await this.server.callTool(toolName, args, meta, options) };
  }

  async invalidateToolsCache(): Promise<void> {
    this.tools = null;
    await this.server.invalidateToolsCache();
  }

  private reconnectTool(): McpTool {
    return {
      name: RECONNECT_TOOL,
      description:
        `The ${this.name} context server could not be reached: ${this.unavailableReason} ` +
        "Call this tool to try connecting again if its context would help. " +
        "On success, its tools are available on your next step. " +
        "If it stays unavailable, say in the report which evidence could not be checked.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    };
  }

  private async reconnect(toolName: string): Promise<CallToolResult> {
    if (toolName !== RECONNECT_TOOL) {
      throw new Error(`${this.name} is unavailable; call ${RECONNECT_TOOL} first`);
    }
    await this.server.close().catch(() => undefined);
    try {
      await this.server.connect();
      await this.server.invalidateToolsCache();
      this.tools = await this.server.listTools();
      this.unavailableReason = null;
      return text(`${this.name} is connected. Its tools are available on your next step.`);
    } catch (error) {
      this.markUnavailable(error);
      return text(
        `${this.name} is still unavailable: ${this.unavailableReason}`,
        true,
      );
    }
  }
}

function text(value: string, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: value }],
    ...(isError ? { isError } : {}),
  };
}
