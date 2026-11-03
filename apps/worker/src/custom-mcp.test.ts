import type { MCPServer } from "@openai/agents";
import { describe, expect, it, vi } from "vitest";
import {
  createCustomMcpServer,
  customMcpHeaders,
  ToolScopedMcpServer,
} from "./custom-mcp.js";

const connection = {
  accessToken: "secret-token",
  accountId: "account-1",
  displayName: "Production metrics",
  mcpUrl: "https://mcp.example.com/mcp",
};

function upstream(): MCPServer {
  return {
    cacheToolsList: true,
    name: "custom-mcp-account-1",
    useStructuredContent: true,
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    invalidateToolsCache: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([
      { name: "list_orders" },
      { name: "refund_order" },
    ]),
    callTool: vi.fn().mockResolvedValue([{ type: "text", text: "ok" }]),
  } as unknown as MCPServer;
}

describe("custom MCP investigation connection", () => {
  it("sends only the selected account's bearer token", () => {
    expect(customMcpHeaders(connection)).toEqual({
      authorization: "Bearer secret-token",
    });
  });

  it("exposes every tool when the connection has no tool list", () => {
    expect(createCustomMcpServer(connection)).not.toBeInstanceOf(ToolScopedMcpServer);
    expect(createCustomMcpServer({ ...connection, allowedTools: null }))
      .not.toBeInstanceOf(ToolScopedMcpServer);
  });

  it("limits a connection to its allowed tools", async () => {
    const created = createCustomMcpServer({
      ...connection,
      allowedTools: ["list_orders"],
    });
    expect(created).toBeInstanceOf(ToolScopedMcpServer);
    expect(created.name).toBe("custom-mcp-account-1");

    const inner = upstream();
    const server = new ToolScopedMcpServer(inner, ["list_orders"]);
    await expect(server.listTools()).resolves.toEqual([{ name: "list_orders" }]);
    await expect(server.callTool("refund_order", { id: "1" }))
      .rejects.toThrow("not allowed on this connection");
    expect(inner.callTool).not.toHaveBeenCalled();
    await expect(server.callTool("list_orders", {})).resolves.toEqual([
      { type: "text", text: "ok" },
    ]);
  });
});
