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
      arguments: { code: expect.stringContaining('method: "GET", path: `/accounts?per_page=50&page=${page}`') },
      name: "execute",
    }));
  });

  it("falls back to the email when the accounts cannot be listed", async () => {
    const callTool = vi.fn(async ({ name }: { name: string }) => {
      if (name === "whoami") return { email: "ops@acme.example", id: "user:cf-user-1" };
      throw new Error("MCP tool execute failed");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(cloudflareConnectionProfile(connection, callTool)).resolves.toMatchObject({
        accounts: [],
        displayName: "ops@acme.example",
        externalAccountId: "user:cf-user-1",
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("lists accounts beyond the first page, up to 200", async () => {
    const pages = Array.from({ length: 5 }, (_, page) =>
      Array.from({ length: 50 }, (_, index) => ({ id: `a${page * 50 + index}`, name: `Account ${page * 50 + index}` }))
    );
    const cloudflare = {
      request: vi.fn(async ({ path }: { method: string; path: string }) => {
        const page = Number(new URL(path, "https://api.cloudflare.com").searchParams.get("page"));
        return { result: pages[page - 1] ?? [], result_info: { page, per_page: 50, total_pages: 5 } };
      }),
    };
    const callTool = vi.fn(async ({ arguments: args, name }: { arguments?: Record<string, unknown>; name: string }) => {
      if (name === "whoami") return { email: "ops@acme.example", id: "user:cf-user-1" };
      // Runs the listing code the way Cloudflare's sandbox does.
      const run = new Function("cloudflare", `return (${String(args?.code)})()`) as (client: unknown) => Promise<unknown>;
      return run(cloudflare);
    });

    const profile = await cloudflareConnectionProfile(connection, callTool);

    expect(profile.accounts).toHaveLength(200);
    expect(profile.accounts.at(-1)).toEqual({ id: "a199", name: "Account 199" });
    expect(cloudflare.request).toHaveBeenCalledTimes(4);
    expect(cloudflare.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
    expect(profile.displayName).toBe("ops@acme.example · 200 accounts");
  });

  it("requires a Cloudflare identity", async () => {
    const callTool = vi.fn(async () => ({ id: "" }));

    await expect(cloudflareConnectionProfile(connection, callTool)).rejects.toThrow();
  });
});
