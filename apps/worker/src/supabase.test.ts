import { describe, expect, it, vi } from "vitest";
import type { MCPServer } from "@openai/agents";
import type { RuntimeSupabaseConnection } from "@responder/core/db/investigations";
import { ScopedSupabaseMcpServer } from "./supabase.js";

function connection(
  accessMode: RuntimeSupabaseConnection["accessMode"],
): RuntimeSupabaseConnection {
  return {
    accessMode,
    accessToken: "access-token",
    accountId: "account-1",
    displayName: "Production",
    mcpUrl: "https://mcp.supabase.com/mcp?project_ref=abcdefghijklmnopqrst",
    projectRef: "abcdefghijklmnopqrst",
  };
}

function upstream(): MCPServer {
  return {
    cacheToolsList: true,
    name: "supabase-upstream",
    useStructuredContent: true,
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    invalidateToolsCache: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([
      { name: "get_logs" },
      { name: "query_logs" },
      { name: "execute_sql" },
      { name: "list_tables" },
      { name: "apply_migration" },
      { name: "deploy_edge_function" },
    ]),
    callTool: vi.fn().mockResolvedValue([{ type: "text", text: "ok" }]),
  } as unknown as MCPServer;
}

describe("Supabase investigation MCP", () => {
  it("exposes only log queries for a logs-only connection", async () => {
    const server = new ScopedSupabaseMcpServer(upstream(), connection("logs"));
    await expect(server.listTools()).resolves.toEqual([
      { name: "get_logs" },
      { name: "query_logs" },
    ]);
    await expect(server.callTool("execute_sql", { query: "select 1" }))
      .rejects.toThrow("not available for this connection");
  });

  it("allows database queries but never migration tools", async () => {
    const server = new ScopedSupabaseMcpServer(
      upstream(),
      connection("read_write"),
    );
    await expect(server.listTools()).resolves.toEqual([
      { name: "get_logs" },
      { name: "query_logs" },
      { name: "execute_sql" },
      { name: "list_tables" },
    ]);
    await expect(server.callTool("execute_sql", { query: "select 1" }))
      .resolves.toEqual([{ type: "text", text: "ok" }]);
    await expect(server.callTool("apply_migration", {})).rejects.toThrow(
      "not available for this connection",
    );
  });
});
