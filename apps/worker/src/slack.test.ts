import type { MCPServer } from "@openai/agents";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeSlackConnection } from "@responder/core/db/investigations";
import { ScopedSlackMcpServer } from "./slack.js";

const activeSpan = vi.hoisted(() => ({
  recordException: vi.fn(),
  setStatus: vi.fn(),
}));

vi.mock("@opentelemetry/api", () => ({
  SpanStatusCode: { ERROR: 2 },
  trace: { getActiveSpan: () => activeSpan },
}));

const connection: RuntimeSlackConnection = {
  accountId: "account-1",
  channels: [
    { id: "C123", name: "incidents" },
    { id: "C456", name: "engineering" },
  ],
  mcpUrl: "https://mcp.slack.com/mcp",
  userAccessToken: "user-token",
};

function upstreamServer() {
  const callTool = vi.fn().mockResolvedValue([{ type: "text", text: "ok" }]);
  const tools = [
    { name: "slack_read_channel" },
    { name: "slack_read_thread" },
    { name: "slack_send_message" },
    { name: "slack_search_public" },
  ] as Awaited<ReturnType<MCPServer["listTools"]>>;
  const server = {
    cacheToolsList: true,
    callTool,
    close: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    invalidateToolsCache: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(tools),
    name: "slack-upstream",
  } as MCPServer;
  return { callTool, server };
}

describe("scoped Slack MCP server", () => {
  it("exposes only read tools that can be channel-scoped", async () => {
    const { server } = upstreamServer();
    const scoped = new ScopedSlackMcpServer(server, connection);

    await expect(scoped.listTools()).resolves.toEqual([
      expect.objectContaining({ name: "slack_read_channel" }),
      expect.objectContaining({ name: "slack_read_thread" }),
    ]);
  });

  it("forwards selected channel reads", async () => {
    const { callTool, server } = upstreamServer();
    const scoped = new ScopedSlackMcpServer(server, connection);

    await scoped.callTool("slack_read_channel", { channel_id: "C123" });

    expect(callTool).toHaveBeenCalledWith(
      "slack_read_channel",
      { channel_id: "C123" },
      undefined,
      undefined,
    );
  });

  it("blocks unselected channels before calling Slack", async () => {
    const { callTool, server } = upstreamServer();
    const scoped = new ScopedSlackMcpServer(server, connection);
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      scoped.callTool("slack_read_channel", { channel_id: "C999" }),
    ).rejects.toThrow("Slack channel is not selected");
    expect(callTool).not.toHaveBeenCalled();
    expect(activeSpan.recordException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Slack channel is not selected for this agent",
      }),
    );
    expect(activeSpan.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "Slack channel is not selected for this agent",
    });
    expect(logError).toHaveBeenCalledWith(
      JSON.stringify({
        event: "slack_mcp_tool_blocked",
        reason: "Slack channel is not selected for this agent",
        serverName: "slack-account-1",
        toolName: "slack_read_channel",
      }),
    );
  });
});
