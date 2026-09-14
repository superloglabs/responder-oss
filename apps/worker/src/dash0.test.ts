import { describe, expect, it, vi } from "vitest";
import { createDash0McpServer, dash0ReadOnlyToolFilter } from "./dash0.js";

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

describe("Dash0 MCP", () => {
  it("allows annotated read-only queries and blocks writes and delegation", async () => {
    await expect(
      dash0ReadOnlyToolFilter(null, {
        name: "getLogRecords",
        annotations: { readOnlyHint: true },
      }),
    ).resolves.toBe(true);
    await expect(
      dash0ReadOnlyToolFilter(null, {
        name: "createCheckRule",
        annotations: { readOnlyHint: false },
      }),
    ).resolves.toBe(false);
    await expect(
      dash0ReadOnlyToolFilter(null, {
        name: "runTask",
        annotations: { readOnlyHint: true },
      }),
    ).resolves.toBe(false);
  });

  it("uses the OAuth access token without passing webhook credentials", () => {
    createDash0McpServer({
      accessToken: "oauth-access-token",
      accountId: "account-1",
      displayName: "Dash0 · production",
      mcpUrl: "https://mcp.eu-west-1.aws.dash0.com/mcp",
    });

    expect(serverConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        requestInit: {
          headers: { authorization: "Bearer oauth-access-token" },
        },
        toolFilter: dash0ReadOnlyToolFilter,
        url: "https://mcp.eu-west-1.aws.dash0.com/mcp",
      }),
    );
  });
});
