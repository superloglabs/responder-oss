import type { MCPCallToolOptions, MCPServer } from "@openai/agents";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { RuntimeSlackConnection } from "@responder/core/db/investigations";
import {
  SLACK_CONTEXT_MCP_TOOLS,
  slackContextToolAccess,
} from "@responder/core/integrations/slack-mcp";
import {
  normalizeSlackSearchQuery,
  searchSlackChannel,
  type SlackChannelSearchResult,
} from "@responder/core/integrations/slack-search";
import { z } from "zod";

const SLACK_SEARCH_TOOL = SLACK_CONTEXT_MCP_TOOLS[0];
const MAX_CACHED_SEARCHES = 20;

const slackSearchToolInputSchema = z
  .object({
    channel_id: z.string().min(1),
    limit: z.number().int().min(1).max(20).optional().default(10),
    query: z.string().min(1).max(500),
  })
  .strict();

export class SlackSearchMcpServer implements MCPServer {
  readonly cacheToolsList = true;
  readonly name: string;
  private readonly channelsById: ReadonlyMap<
    string,
    RuntimeSlackConnection["channels"][number]
  >;
  private readonly searchCache = new Map<
    string,
    Promise<SlackChannelSearchResult>
  >();

  constructor(private readonly connection: RuntimeSlackConnection) {
    this.name = `slack-${connection.accountId}`;
    this.channelsById = new Map(
      connection.channels.map((channel) => [channel.id, channel]),
    );
  }

  async connect(): Promise<void> {}

  async close(): Promise<void> {
    this.searchCache.clear();
  }

  async listTools(): ReturnType<MCPServer["listTools"]> {
    const channels = this.connection.channels
      .map((channel) => `#${channel.name} (${channel.id})`)
      .join(", ");
    return [
      {
        name: SLACK_SEARCH_TOOL,
        description:
          "Search one Slack channel selected for this agent. Use concise keywords from the incident. Search modifiers are not accepted. " +
          `Available channels: ${channels}.`,
        inputSchema: {
          type: "object",
          properties: {
            channel_id: {
              type: "string",
              enum: this.connection.channels.map((channel) => channel.id),
              description: "Selected Slack channel ID",
            },
            query: {
              type: "string",
              minLength: 1,
              maxLength: 500,
              description: "Keywords or an exact error phrase without Slack modifiers",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 20,
              default: 10,
              description: "Maximum matching messages to return",
            },
          },
          required: ["channel_id", "query"],
          additionalProperties: false,
        },
      },
    ];
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> | null,
    _meta?: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): ReturnType<MCPServer["callTool"]> {
    const access = slackContextToolAccess({
      allowedChannelIds: new Set(this.channelsById.keys()),
      args,
      toolName,
    });
    if (!access.allowed) {
      this.recordBlockedTool(toolName, access.reason);
      throw new Error(access.reason);
    }

    const parsed = slackSearchToolInputSchema.safeParse(args);
    if (!parsed.success) {
      throw new Error("Invalid Slack channel search arguments");
    }
    const channel = this.channelsById.get(parsed.data.channel_id);
    if (!channel) {
      throw new Error("Slack channel is not selected for this agent");
    }
    const query = normalizeSlackSearchQuery(parsed.data.query);
    const cacheKey = JSON.stringify([channel.id, query, parsed.data.limit]);
    let search = this.searchCache.get(cacheKey);
    if (!search) {
      search = searchSlackChannel({
        accessToken: this.connection.userAccessToken,
        channel,
        limit: parsed.data.limit,
        query,
        signal: options?.signal,
      });
      if (this.searchCache.size < MAX_CACHED_SEARCHES) {
        this.searchCache.set(cacheKey, search);
        void search.catch(() => {
          if (this.searchCache.get(cacheKey) === search) {
            this.searchCache.delete(cacheKey);
          }
        });
      }
    }

    const result = await search;
    return [{ type: "text", text: JSON.stringify(result) }];
  }

  async invalidateToolsCache(): Promise<void> {}

  private recordBlockedTool(toolName: string, reason: string): void {
    const error = new Error(reason);
    const span = trace.getActiveSpan();
    span?.recordException(error);
    span?.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    console.error(
      JSON.stringify({
        event: "slack_search_tool_blocked",
        reason,
        serverName: this.name,
        toolName,
      }),
    );
  }
}

export function createSlackSearchServer(
  connection: RuntimeSlackConnection,
): MCPServer {
  return new SlackSearchMcpServer(connection);
}
