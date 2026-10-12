import { describe, expect, it, vi } from "vitest";
import { cloudflareToolFilter, createCloudflareMcpServer } from "./cloudflare.js";

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

describe("Cloudflare MCP", () => {
  it("allows only the API, docs, and identity tools", async () => {
    await expect(cloudflareToolFilter(null, { name: "execute" })).resolves.toBe(true);
    await expect(cloudflareToolFilter(null, { name: "search" })).resolves.toBe(true);
    await expect(
      cloudflareToolFilter(null, {
        annotations: { readOnlyHint: true },
        name: "get_workers_scripts",
      }),
    ).resolves.toBe(false);
  });

  it("connects to the hosted server with the OAuth token", () => {
    createCloudflareMcpServer({
      accessToken: "oauth-access-token",
      accountId: "account-1",
      accounts: [{ id: "a1", name: "Acme" }],
      displayName: "Acme",
      mcpUrl: "https://mcp.cloudflare.com/mcp",
    });

    expect(serverConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "cloudflare-account-1",
        requestInit: {
          headers: { authorization: "Bearer oauth-access-token" },
        },
        toolFilter: cloudflareToolFilter,
        url: "https://mcp.cloudflare.com/mcp",
      }),
    );
  });
});
