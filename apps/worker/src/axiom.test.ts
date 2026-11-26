import { describe, expect, it, vi } from "vitest";
import {
  AXIOM_READ_ONLY_MCP_TOOLS,
  axiomReadOnlyToolFilter,
  createAxiomMcpServer,
  isAxiomObservationTool,
} from "./axiom.js";

const { serverConstructor, listTools, callToolResult } = vi.hoisted(() => ({
  serverConstructor: vi.fn(),
  listTools: vi.fn(),
  callToolResult: vi.fn(),
}));

vi.mock("@openai/agents", () => ({
  MCPServerStreamableHttp: class {
    constructor(options: unknown) {
      serverConstructor(options);
    }

    listTools() {
      return listTools();
    }

    callToolResult(...args: unknown[]) {
      return callToolResult(...args);
    }

    // As in the SDK, callTool goes through callToolResult.
    async callTool(name: string, args: Record<string, unknown> | null) {
      return ((await this.callToolResult(name, args)) as { content: unknown }).content;
    }
  },
}));

// The query tool as Axiom lists it: marked as able to write, with saveResults.
const queryDataset = {
  name: "queryDataset",
  description: "Run an APL query",
  annotations: { readOnlyHint: false, destructiveHint: false },
  inputSchema: {
    type: "object",
    properties: {
      apl: { type: "string" },
      saveResults: { type: "boolean" },
      startTime: { type: "string" },
    },
    required: ["apl"],
  },
};

describe("Axiom MCP", () => {
  it("allows inspection tools and rejects mutation tools", async () => {
    await expect(
      axiomReadOnlyToolFilter(null, { name: "queryDataset" }),
    ).resolves.toBe(true);
    await expect(
      axiomReadOnlyToolFilter(null, { name: "createMonitor" }),
    ).resolves.toBe(false);
    await expect(
      axiomReadOnlyToolFilter(null, { name: "deleteDashboard" }),
    ).resolves.toBe(false);
    expect(AXIOM_READ_ONLY_MCP_TOOLS).not.toContain("updateMonitor");
  });

  it("filters tools only for read-only runs", () => {
    const connection = { accessToken: "token", mcpUrl: "https://mcp.axiom.co/mcp" };

    createAxiomMcpServer(connection, { readOnly: false });
    expect(serverConstructor.mock.lastCall?.[0]).not.toHaveProperty("toolFilter");

    createAxiomMcpServer(connection, { readOnly: true });
    expect(serverConstructor.mock.lastCall?.[0]).toMatchObject({ toolFilter: axiomReadOnlyToolFilter });
  });

  it("authenticates the hosted MCP connection with OAuth", () => {
    createAxiomMcpServer({
      accessToken: "oauth-access-token",
      mcpUrl: "https://mcp.axiom.co/mcp",
    }, { readOnly: true });

    expect(serverConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        requestInit: {
          headers: {
            authorization: "Bearer oauth-access-token",
          },
        },
        toolFilter: axiomReadOnlyToolFilter,
        url: "https://mcp.axiom.co/mcp",
      }),
    );
  });

  it("keeps the allowlisted query tools for observers", () => {
    expect(isAxiomObservationTool({ name: "queryDataset" })).toBe(true);
    expect(isAxiomObservationTool({ name: "queryMetrics" })).toBe(true);
    expect(isAxiomObservationTool({ name: "createMonitor" })).toBe(false);
  });

  it("hides saveResults from read-only query tools and never saves", async () => {
    const connection = { accessToken: "token", mcpUrl: "https://mcp.axiom.co/mcp" };
    listTools.mockResolvedValue([queryDataset, { name: "listDatasets", inputSchema: { type: "object", properties: {} } }]);
    callToolResult.mockResolvedValue({ content: [] });

    const readOnly = createAxiomMcpServer(connection, { readOnly: true });
    const [query, datasets] = await readOnly.listTools();
    expect(Object.keys(query!.inputSchema.properties as object)).toEqual(["apl", "startTime"]);
    expect(query!.inputSchema.required).toEqual(["apl"]);
    expect(datasets!.inputSchema.properties).toEqual({});

    await readOnly.callTool("queryDataset", { apl: "['logs'] | take 1", saveResults: true });
    expect(callToolResult.mock.lastCall?.slice(0, 2)).toEqual([
      "queryDataset", { apl: "['logs'] | take 1", saveResults: false },
    ]);
    await readOnly.callToolResult("queryMetrics", null);
    expect(callToolResult.mock.lastCall?.slice(0, 2)).toEqual(["queryMetrics", { saveResults: false }]);
    await readOnly.callToolResult("listDatasets", { truncate: true });
    expect(callToolResult.mock.lastCall?.slice(0, 2)).toEqual(["listDatasets", { truncate: true }]);

    // Tag mode keeps saveResults.
    const full = createAxiomMcpServer(connection, { readOnly: false });
    await full.callToolResult("queryDataset", { apl: "x", saveResults: true });
    expect(callToolResult.mock.lastCall?.slice(0, 2)).toEqual(["queryDataset", { apl: "x", saveResults: true }]);
  });
});
