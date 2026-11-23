import { safeCustomMcpFetch } from "@responder/core/integrations/custom-mcp";
import { describe, expect, it, vi } from "vitest";
import { createHoneycombMcpServer } from "./honeycomb.js";

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

describe("Honeycomb MCP", () => {
  it("opens the team's regional server with its key as a bearer token", () => {
    createHoneycombMcpServer({
      accountId: "a0000000-0000-4000-8000-000000000000",
      displayName: "Acme",
      keyId: "hcxmk_key",
      keySecret: "secret-value",
      mcpUrl: "https://mcp.eu1.honeycomb.io/mcp",
    });

    expect(serverConstructor).toHaveBeenCalledWith(expect.objectContaining({
      fetch: safeCustomMcpFetch,
      name: "honeycomb-a0000000-0000-4000-8000-000000000000",
      requestInit: { headers: { authorization: "Bearer hcxmk_key:secret-value" } },
      url: "https://mcp.eu1.honeycomb.io/mcp",
    }));
  });
});
