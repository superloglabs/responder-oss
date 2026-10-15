import { describe, expect, it, vi } from "vitest";
import {
  AXIOM_READ_ONLY_MCP_TOOLS,
  axiomReadOnlyToolFilter,
  createAxiomMcpServer,
} from "./axiom.js";

const { serverConstructor } = vi.hoisted(() => ({
  serverConstructor: vi.fn(),
}));

vi.mock("@openai/agents", () => ({
  MCPServerStreamableHttp: class {
    constructor(options: unknown) {
      serverConstructor(options);
    }
  },
}));

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
});
