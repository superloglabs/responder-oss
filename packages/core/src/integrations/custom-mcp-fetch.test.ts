import { beforeEach, describe, expect, it, vi } from "vitest";

const networkMocks = vi.hoisted(() => ({
  agentOptions: [] as Array<Record<string, unknown>>,
  close: vi.fn(async () => undefined),
  destroy: vi.fn(async () => undefined),
  fetch: vi.fn(),
  lookup: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({ lookup: networkMocks.lookup }));
vi.mock("undici", () => ({
  Agent: class MockAgent {
    readonly options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      networkMocks.agentOptions.push(options);
    }

    close = networkMocks.close;
    destroy = networkMocks.destroy;
  },
  fetch: networkMocks.fetch,
}));

import {
  safeCustomMcpFetch,
  validateCustomMcpUrl,
} from "./custom-mcp.js";

interface MockAgentOptions {
  connect: {
    lookup: (
      hostname: string,
      options: Record<string, unknown>,
      callback: (
        error: Error | null,
        address: string | Array<{ address: string; family: number }>,
        family?: number,
      ) => void,
    ) => void;
    servername?: string;
  };
  maxResponseSize: number;
}

function latestAgentOptions(): MockAgentOptions {
  return networkMocks.agentOptions.at(-1) as unknown as MockAgentOptions;
}

describe("safe custom MCP fetch", () => {
  beforeEach(() => {
    networkMocks.agentOptions.length = 0;
    networkMocks.close.mockClear();
    networkMocks.destroy.mockClear();
    networkMocks.fetch.mockReset();
    networkMocks.lookup.mockReset();
    networkMocks.lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ]);
  });

  it("pins the approved DNS answer while retaining hostname TLS verification", async () => {
    networkMocks.fetch.mockImplementation(async () => {
      const options = latestAgentOptions();
      let pinned: { address: string; family: number } | undefined;
      options.connect.lookup(
        "mcp.example.test",
        { family: 4 },
        (error, address, family) => {
          expect(error).toBeNull();
          expect(typeof address).toBe("string");
          pinned = { address: address as string, family: family as number };
        },
      );
      expect(pinned).toEqual({ address: "93.184.216.34", family: 4 });
      return new Response("ok");
    });

    const response = await safeCustomMcpFetch("https://mcp.example.test/mcp");

    expect(await response.text()).toBe("ok");
    expect(networkMocks.lookup).toHaveBeenCalledTimes(1);
    expect(latestAgentOptions()).toMatchObject({
      connect: { servername: "mcp.example.test" },
      maxResponseSize: 8 * 1024 * 1024,
    });
  });

  it("offers only approved addresses and prefers IPv4 for dual-stack hosts", async () => {
    networkMocks.lookup.mockResolvedValue([
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      { address: "93.184.216.34", family: 4 },
    ]);
    networkMocks.fetch.mockImplementation(async () => {
      let pinned: unknown;
      latestAgentOptions().connect.lookup(
        "mcp.example.test",
        { all: true },
        (error, addresses) => {
          expect(error).toBeNull();
          pinned = addresses;
        },
      );
      expect(pinned).toEqual([
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ]);
      return new Response("ok");
    });

    await safeCustomMcpFetch("https://mcp.example.test/mcp");
  });

  it("fails closed when DNS returns any private address", async () => {
    networkMocks.lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.42.0.9", family: 4 },
    ]);

    await expect(
      safeCustomMcpFetch("https://mcp.example.test/mcp"),
    ).rejects.toThrow("MCP URLs must resolve only to public addresses");
    expect(networkMocks.fetch).not.toHaveBeenCalled();
  });

  it("bounds DNS lookup time before opening a connection", async () => {
    networkMocks.lookup.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const pending = validateCustomMcpUrl("https://mcp.example.test/mcp", {
      signal: controller.signal,
    });

    controller.abort(new Error("DNS lookup deadline exceeded"));

    await expect(pending).rejects.toThrow("DNS lookup deadline exceeded");
    expect(networkMocks.fetch).not.toHaveBeenCalled();
  });

  it("re-resolves and rejects a same-origin redirect that becomes private", async () => {
    networkMocks.lookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "10.42.0.9", family: 4 }]);
    networkMocks.fetch.mockResolvedValueOnce(
      new Response("redirect", {
        headers: { location: "/next" },
        status: 307,
      }),
    );

    await expect(
      safeCustomMcpFetch("https://mcp.example.test/mcp", {
        body: "request body",
        method: "POST",
      }),
    ).rejects.toThrow("MCP URLs must resolve only to public addresses");
    expect(networkMocks.lookup).toHaveBeenCalledTimes(2);
    expect(networkMocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not forward credentials or request bodies across origins", async () => {
    networkMocks.fetch.mockResolvedValueOnce(
      new Response("redirect", {
        headers: { location: "https://other.example.test/mcp" },
        status: 307,
      }),
    );

    await expect(
      safeCustomMcpFetch("https://mcp.example.test/mcp", {
        body: "sensitive request body",
        headers: { authorization: "Bearer secret" },
        method: "POST",
      }),
    ).rejects.toThrow("MCP requests cannot redirect to another origin");
    expect(networkMocks.fetch).toHaveBeenCalledTimes(1);
    expect(networkMocks.lookup).toHaveBeenCalledTimes(1);
  });
});
