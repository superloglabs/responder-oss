import {
  Agent,
  getAllMcpTools,
  RunContext,
  type MCPServer,
} from "@openai/agents";
import { describe, expect, it, vi } from "vitest";
import { RECONNECT_TOOL, RecoverableMcpServer } from "./recoverable-mcp.js";

const inputSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
} as const;
const readTool = {
  name: "list_issues",
  description: "Search issues",
  inputSchema,
  annotations: { readOnlyHint: true },
};
const writeTool = { name: "save_issue", description: "Save an issue", inputSchema };

function fakeServer(options: Partial<MCPServer> = {}) {
  return {
    cacheToolsList: true,
    name: "linear",
    useStructuredContent: true,
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([readTool]),
    callTool: vi.fn().mockResolvedValue([{ type: "text", text: "[]" }]),
    callToolResult: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "[]" }] }),
    invalidateToolsCache: vi.fn().mockResolvedValue(undefined),
    ...options,
  } satisfies MCPServer;
}

function recoverable(server: MCPServer) {
  return new RecoverableMcpServer(server, (error) =>
    error instanceof Error ? error.message : String(error),
  );
}

async function exposedToolNames(server: MCPServer): Promise<string[]> {
  const tools = await getAllMcpTools({
    agent: new Agent({ name: "test" }),
    includeServerInToolNames: true,
    mcpServers: [server],
    runContext: new RunContext(),
  });
  return tools.map((tool) => tool.name);
}

describe("recoverable MCP server", () => {
  it("passes tools and calls through while connected", async () => {
    const server = fakeServer();
    const wrapped = recoverable(server);

    await wrapped.connect();

    expect(await wrapped.listTools()).toEqual([readTool]);
    expect(await wrapped.listTools()).toEqual([readTool]);
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
    expect(wrapped.available).toBe(false);
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
      { type: "text", text: "linear is connected. Its tools are available on your next step." },
    ]);
    expect(server.close).toHaveBeenCalledOnce();
    expect(server.connect).toHaveBeenCalledOnce();
    expect(wrapped.available).toBe(true);
    expect(await wrapped.listTools()).toEqual([readTool]);
  });

  it("reports a failed reconnect to the agent without failing the run", async () => {
    const server = fakeServer({
      connect: vi.fn().mockRejectedValue(new Error("HTTP 503")),
    });
    const wrapped = recoverable(server);
    wrapped.markUnavailable(new Error("HTTP 500"));

    const result = await wrapped.callToolResult(RECONNECT_TOOL, {});

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "linear is still unavailable: HTTP 503" },
    ]);
    const tools = await wrapped.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([RECONNECT_TOOL]);
    expect(tools[0]?.description).toContain("HTTP 503");
  });

  it("falls back to the reconnect tool when listing tools fails", async () => {
    const server = fakeServer({
      listTools: vi.fn().mockRejectedValueOnce(new Error("HTTP 502")),
    });
    const wrapped = recoverable(server);

    await wrapped.connect();

    const tools = await wrapped.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([RECONNECT_TOOL]);
    expect(tools[0]?.description).toContain("HTTP 502");
  });

  it("shows the agent the error as returned by the describer", async () => {
    const wrapped = new RecoverableMcpServer(
      fakeServer({ name: "upstash-account-1" }),
      (error) => String(error instanceof Error ? error.message : error)
        .replaceAll("upstash-api-key", "[redacted]"),
    );

    wrapped.markUnavailable(new Error("HTTP 401: invalid key upstash-api-key"));

    const [tool] = await wrapped.listTools();
    expect(tool?.description).toContain("HTTP 401: invalid key [redacted]");
    expect(tool?.description).not.toContain("upstash-api-key");
  });

  it("lets the SDK swap the reconnect tool for the real tools between turns", async () => {
    const wrapped = recoverable(fakeServer());
    wrapped.markUnavailable(new Error("HTTP 500"));

    const before = await exposedToolNames(wrapped);
    await wrapped.callToolResult(RECONNECT_TOOL, {});
    const after = await exposedToolNames(wrapped);

    expect(before).toHaveLength(1);
    expect(before[0]).toContain(RECONNECT_TOOL);
    expect(after).toHaveLength(1);
    expect(after[0]).toContain("list_issues");
  });

  it.each([
    [
      "callable",
      async (_context: unknown, tool: { annotations?: { readOnlyHint?: boolean } }) =>
        tool.annotations?.readOnlyHint === true,
    ],
    ["static", { allowedToolNames: ["list_issues"] }],
  ] as const)(
    "keeps the server's %s read-only filter on real tools",
    async (_kind, toolFilter) => {
      const server = fakeServer({
        listTools: vi.fn().mockResolvedValue([readTool, writeTool]),
        toolFilter: toolFilter as MCPServer["toolFilter"],
      });
      const wrapped = recoverable(server);

      wrapped.markUnavailable(new Error("HTTP 500"));
      const unavailable = await exposedToolNames(wrapped);
      await wrapped.callToolResult(RECONNECT_TOOL, {});
      const reconnected = await exposedToolNames(wrapped);

      expect(unavailable).toHaveLength(1);
      expect(unavailable[0]).toContain(RECONNECT_TOOL);
      expect(reconnected).toHaveLength(1);
      expect(reconnected[0]).toContain("list_issues");
    },
  );
});
