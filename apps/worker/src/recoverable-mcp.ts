import type {
  CallToolResult,
  CallToolResultContent,
  MCPCallToolOptions,
  MCPServer,
} from "@openai/agents";

type McpTool = Awaited<ReturnType<MCPServer["listTools"]>>[number];

export const RECONNECT_TOOL = "reconnect";

const MAX_ERROR_LENGTH = 500;

/**
 * Keeps an optional context server from failing the investigation when it is
 * unreachable. While it is down, the agent sees the error and a single
 * reconnect tool, and decides whether retrying is worth it.
 */
export class RecoverableMcpServer implements MCPServer {
  // The SDK lists tools before every turn; this class caches them itself so a
  // reconnect can replace the placeholder tool.
  readonly cacheToolsList = false;
  readonly name: string;
  readonly useStructuredContent: boolean | undefined;
  private tools: McpTool[] | null = null;
  private unavailableReason: string | null = null;

  constructor(
    private readonly server: MCPServer,
    private readonly label: string,
    private readonly describeError: (error: unknown) => string,
  ) {
    this.name = server.name;
    this.useStructuredContent = server.useStructuredContent;
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
    if (this.unavailableReason !== null) return [this.reconnectTool()];
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
        `${this.label} could not be reached: ${this.unavailableReason} ` +
        `Call this tool to try connecting again if ${this.label} context would help. ` +
        `On success, the ${this.label} tools are available on your next step. ` +
        `If ${this.label} stays unavailable, say in the report that it could not be checked.`,
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
      throw new Error(`${this.label} is unavailable; call ${RECONNECT_TOOL} first`);
    }
    await this.server.close().catch(() => undefined);
    try {
      await this.server.connect();
      await this.server.invalidateToolsCache();
      this.tools = await this.server.listTools();
      this.unavailableReason = null;
      return text(`${this.label} is connected. Its tools are available on your next step.`);
    } catch (error) {
      this.markUnavailable(error);
      return text(
        `${this.label} is still unavailable: ${this.unavailableReason}`,
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
