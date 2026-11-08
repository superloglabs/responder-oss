import type { MCPServer } from "@openai/agents";
import { describe, expect, it, vi } from "vitest";
import { datadogObservationUrl, isObservationTool, ObservationMcpServer } from "./context-servers.js";

const tool = (name: string, annotations?: Record<string, unknown>) =>
  ({ name, description: name, inputSchema: { type: "object", properties: {} }, ...(annotations ? { annotations } : {}) }) as never;

describe("observation tools", () => {
  it("keeps read-only tools and drops ones that write", () => {
    expect(isObservationTool(tool("search_datadog_logs"))).toBe(true);
    expect(isObservationTool(tool("get_issue_details", { readOnlyHint: true }))).toBe(true);
    // Declared read-only wins over a name that sounds like a write.
    expect(isObservationTool(tool("start_query", { readOnlyHint: true }))).toBe(true);
    expect(isObservationTool(tool("create_datadog_monitor"))).toBe(false);
    expect(isObservationTool(tool("update_issue"))).toBe(false);
    expect(isObservationTool(tool("delete-notebook"))).toBe(false);
    expect(isObservationTool(tool("list_things", { readOnlyHint: false }))).toBe(false);
    expect(isObservationTool(tool("get_things", { destructiveHint: true, readOnlyHint: true }))).toBe(false);
  });

  it("applies the provider's filter and refuses tools it left out", async () => {
    const callTool = vi.fn().mockResolvedValue([{ type: "text", text: "ok" }]);
    const server = {
      name: "grafana-1",
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue([tool("query_loki_logs"), tool("list_datasources"), tool("create_alert_rule")]),
      callTool,
      toolFilter: async (_context: unknown, candidate: { name: string }) => candidate.name !== "list_datasources",
    } as unknown as MCPServer;
    const observed = new ObservationMcpServer(server, String);
    await observed.connect();
    expect((await observed.listTools()).map((candidate) => candidate.name)).toEqual(["query_loki_logs"]);
    await expect(observed.callTool("create_alert_rule", {})).rejects.toThrow("not available");
    await observed.callTool("query_loki_logs", { query: "{app=\"x\"}" });
    expect(callTool).toHaveBeenCalledWith("query_loki_logs", { query: "{app=\"x\"}" });
  });

  it("reports a server it could not reach instead of failing", async () => {
    const server = {
      name: "datadog",
      connect: vi.fn().mockRejectedValue(new Error("401 for key dd-secret")),
      close: vi.fn(),
      listTools: vi.fn(),
    } as unknown as MCPServer;
    const observed = new ObservationMcpServer(server, (error) => String((error as Error).message).replace("dd-secret", "[redacted]"));
    await observed.connect();
    expect(observed.unavailable).toBe("401 for key [redacted]");
    expect(await observed.listTools()).toEqual([]);
  });

  it("asks Datadog for every toolset", () => {
    expect(datadogObservationUrl("https://mcp.datadoghq.eu/v1/mcp")).toBe("https://mcp.datadoghq.eu/v1/mcp?toolsets=all%2Capm");
  });
});
