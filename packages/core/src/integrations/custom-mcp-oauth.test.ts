import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  fetch: vi.fn(),
  lookup: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("undici", () => ({
  Agent: class MockAgent {
    close = vi.fn(async () => undefined);
    destroy = vi.fn(async () => undefined);
  },
  fetch: mocks.fetch,
}));
vi.mock("@modelcontextprotocol/sdk/client/auth.js", async (importOriginal) => ({
  ...(await importOriginal()),
  auth: mocks.auth,
}));

import { beginCustomMcpOAuth } from "./custom-mcp.js";

describe("custom MCP OAuth discovery", () => {
  beforeEach(() => {
    mocks.auth.mockReset();
    mocks.fetch.mockReset();
    mocks.lookup.mockReset();
    mocks.lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ]);
  });

  it("honors protected resource metadata advertised by the MCP challenge", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(null, {
        headers: {
          "www-authenticate":
            'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource", scope="openid offline_access"',
        },
        status: 401,
      }),
    );
    mocks.auth.mockImplementation(async (provider) => {
      provider.redirectToAuthorization(
        new URL("https://authorization.example.test/oauth2/authorize"),
      );
      return "REDIRECT";
    });

    await beginCustomMcpOAuth({
      connectionState: "oauth-state",
      mcpUrl: "https://mcp.example.test/mcp",
      redirectUrl: "https://responder.example/api/integrations/axiom/callback",
    });

    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://mcp.example.test/mcp",
      expect.objectContaining({ method: "GET" }),
    );
    expect(mocks.auth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resourceMetadataUrl: new URL(
          "https://mcp.example.test/.well-known/oauth-protected-resource",
        ),
        scope: "openid offline_access",
      }),
    );
  });
});
