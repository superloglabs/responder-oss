import { describe, expect, it, vi } from "vitest";
import { cloudflareConnectionProfile } from "./cloudflare.js";

const connection = { accessToken: "oauth-access-token", mcpUrl: "https://mcp.cloudflare.com/mcp" };

describe("Cloudflare connection profile", () => {
  it("names a single-account connection after its account", async () => {
    const callTool = vi.fn(async ({ name }: { name: string }) =>
      name === "whoami"
        ? { email: "ops@acme.example", id: "user:cf-user-1" }
        : [{ id: "a1", name: "Acme" }]
    );

    await expect(cloudflareConnectionProfile(connection, callTool)).resolves.toEqual({
      accounts: [{ id: "a1", name: "Acme" }],
      displayName: "Acme",
      email: "ops@acme.example",
      externalAccountId: "user:cf-user-1",
    });
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({
      arguments: { code: expect.stringContaining('method: "GET", path: "/accounts?per_page=50"') },
      name: "execute",
    }));
  });

  it("falls back to the email when the accounts cannot be listed", async () => {
    const callTool = vi.fn(async ({ name }: { name: string }) => {
      if (name === "whoami") return { email: "ops@acme.example", id: "user:cf-user-1" };
      throw new Error("MCP tool execute failed");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(cloudflareConnectionProfile(connection, callTool)).resolves.toMatchObject({
      accounts: [],
      displayName: "ops@acme.example",
      externalAccountId: "user:cf-user-1",
    });
    consoleError.mockRestore();
  });

  it("requires a Cloudflare identity", async () => {
    const callTool = vi.fn(async () => ({ id: "" }));

    await expect(cloudflareConnectionProfile(connection, callTool)).rejects.toThrow();
  });
});
