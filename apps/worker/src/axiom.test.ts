import { describe, expect, it, vi } from "vitest";
import {
  AXIOM_ALERTING_MCP_TOOLS,
  AXIOM_READ_ONLY_MCP_TOOLS,
  axiomToolFilter,
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
  it("allows only inspection tools without alerting access", async () => {
    const filter = axiomToolFilter({ alerting: false });

    await expect(filter(null, { name: "queryDataset" })).resolves.toBe(true);
    await expect(filter(null, { name: "createMonitor" })).resolves.toBe(false);
    await expect(filter(null, { name: "deleteDashboard" })).resolves.toBe(false);
    expect(AXIOM_READ_ONLY_MCP_TOOLS).not.toContain("updateMonitor");
  });

  it("adds monitor and notifier writes with alerting access", async () => {
    const filter = axiomToolFilter({ alerting: true });

    await expect(filter(null, { name: "queryDataset" })).resolves.toBe(true);
    await expect(filter(null, { name: "createMonitor" })).resolves.toBe(true);
    await expect(filter(null, { name: "updateNotifier" })).resolves.toBe(true);
    await expect(filter(null, { name: "deleteMonitor" })).resolves.toBe(false);
    await expect(filter(null, { name: "createDashboard" })).resolves.toBe(false);
    await expect(filter(null, { name: "createDataset" })).resolves.toBe(false);
    expect(AXIOM_ALERTING_MCP_TOOLS).not.toContain("deleteNotifier");
  });

  it("authenticates the hosted MCP connection with OAuth", () => {
    createAxiomMcpServer({
      accessToken: "oauth-access-token",
      mcpUrl: "https://mcp.axiom.co/mcp",
    }, { alerting: false });

    expect(serverConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        requestInit: {
          headers: {
            authorization: "Bearer oauth-access-token",
          },
        },
        toolFilter: expect.any(Function),
        url: "https://mcp.axiom.co/mcp",
      }),
    );
  });
});
