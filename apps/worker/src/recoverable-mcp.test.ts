import { getAllMcpTools, type MCPServer } from "@openai/agents";
import { describe, expect, it, vi } from "vitest";
import { RECONNECT_TOOL, RecoverableMcpServer } from "./recoverable-mcp.js";

const searchTool = {
  name: "list_issues",
  description: "Search Linear issues",
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
} as const;

function fakeServer() {
  return {
    cacheToolsList: true,
    name: "linear",
    useStructuredContent: true,
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([searchTool]),
    callTool: vi.fn().mockResolvedValue([{ type: "text", text: "[]" }]),
    callToolResult: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "[]" }] }),
    invalidateToolsCache: vi.fn().mockResolvedValue(undefined),
  } satisfies MCPServer;
}

function recoverable(server: MCPServer) {
  return new RecoverableMcpServer(server, "Linear", (error) =>
    error instanceof Error ? error.message : String(error),
  );
}

describe("recoverable MCP server", () => {
  it("passes tools and calls through while connected", async () => {
    const server = fakeServer();
    const wrapped = recoverable(server);

    await wrapped.connect();

    expect(await wrapped.listTools()).toEqual([searchTool]);
    expect(await wrapped.listTools()).toEqual([searchTool]);
    expect(server.listTools).toHaveBeenCalledOnce();
    await wrapped.callToolResult("list_issues", { query: "timeout" });
    expect(server.callToolResult).toHaveBeenCalledWith(
      "list_issues",
      { query: "timeout" },
      undefined,
      undefined,
    );
  });

  it("shows the connection error and a reconnect tool while unavailable", async () => {
    const wrapped = recoverable(fakeServer());

    wrapped.markUnavailable(new Error("Error 1101: Worker threw exception"));

    const tools = await wrapped.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([RECONNECT_TOOL]);
    expect(tools[0]?.description).toContain("Error 1101: Worker threw exception");
    await expect(wrapped.callToolResult("list_issues", {})).rejects.toThrow(
      "call reconnect first",
    );
  });

  it("restores the real tools after a successful reconnect", async () => {
    const server = fakeServer();
    const wrapped = recoverable(server);
    wrapped.markUnavailable(new Error("HTTP 500"));

    const result = await wrapped.callToolResult(RECONNECT_TOOL, {});

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      { type: "text", text: "Linear is connected. Its tools are available on your next step." },
    ]);
    expect(server.close).toHaveBeenCalledOnce();
    expect(server.connect).toHaveBeenCalledOnce();
    expect(await wrapped.listTools()).toEqual([searchTool]);
  });

  it("reports a failed reconnect to the agent without failing the run", async () => {
    const server = fakeServer();
    server.connect.mockRejectedValue(new Error("HTTP 503"));
    const wrapped = recoverable(server);
    wrapped.markUnavailable(new Error("HTTP 500"));

    const result = await wrapped.callToolResult(RECONNECT_TOOL, {});

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "Linear is still unavailable: HTTP 503" },
    ]);
    const tools = await wrapped.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([RECONNECT_TOOL]);
    expect(tools[0]?.description).toContain("HTTP 503");
  });

  it("falls back to the reconnect tool when listing tools fails", async () => {
    const server = fakeServer();
    server.listTools.mockRejectedValueOnce(new Error("HTTP 502"));
    const wrapped = recoverable(server);

    await wrapped.connect();

    const tools = await wrapped.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([RECONNECT_TOOL]);
    expect(tools[0]?.description).toContain("HTTP 502");
  });

  it("lets the SDK swap the reconnect tool for the real tools between turns", async () => {
    const wrapped = recoverable(fakeServer());
    wrapped.markUnavailable(new Error("HTTP 500"));
    const listNames = async () =>
      (await getAllMcpTools({ mcpServers: [wrapped], includeServerInToolNames: true }))
        .map((tool) => tool.name);

    const before = await listNames();
    await wrapped.callToolResult(RECONNECT_TOOL, {});
    const after = await listNames();

    expect(before).toHaveLength(1);
    expect(before[0]).toContain(RECONNECT_TOOL);
    expect(after).toHaveLength(1);
    expect(after[0]).toContain("list_issues");
  });
});
