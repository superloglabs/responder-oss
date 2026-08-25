import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSentryMcpFetch,
  createSentryMcpServer,
  sentryMcpHeaders,
} from "./sentry.js";

const { serverCallToolResult, serverConstructor, serverOptions } = vi.hoisted(
  () => ({
    serverCallToolResult: vi.fn(),
    serverConstructor: vi.fn(),
    serverOptions: { current: null as Record<string, unknown> | null },
  }),
);

vi.mock("@openai/agents", () => ({
  MCPServerStreamableHttp: class {
    constructor(options: unknown) {
      serverConstructor(options);
      serverOptions.current = options as Record<string, unknown>;
    }

    callToolResult(...args: unknown[]) {
      return serverCallToolResult(...args);
    }
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  serverCallToolResult.mockReset();
  serverConstructor.mockClear();
  serverOptions.current = null;
});

describe("Sentry MCP", () => {
  it("uses the explicit upstream-token authorization scheme", () => {
    expect(
      sentryMcpHeaders({
        accessToken: "sentry-test-token",
        mcpUrl: "https://mcp.sentry.dev/mcp/acme/api?skills=inspect",
        organizationSlug: "acme",
        projectSlug: "api",
      }),
    ).toEqual({ authorization: "Sentry-Bearer sentry-test-token" });
  });

  it("adds investigation-aware transport logging to the MCP server", () => {
    createSentryMcpServer(
      {
        accessToken: "sentry-test-token",
        mcpUrl: "https://mcp.sentry.dev/mcp/acme/api?skills=inspect",
        organizationSlug: "acme",
        projectSlug: "api",
      },
      { investigationId: "investigation-1" },
    );

    expect(serverConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ fetch: expect.any(Function) }),
    );
  });

  it("logs every tool-call failure with its investigation", async () => {
    const failure = new Error("sanitized transport failure");
    failure.name = "MCPTransportError";
    serverCallToolResult.mockRejectedValue(failure);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = createSentryMcpServer(
      {
        accessToken: "sentry-test-token",
        mcpUrl: "https://mcp.sentry.dev/mcp/acme/api?skills=inspect",
        organizationSlug: "acme",
        projectSlug: "api",
      },
      { investigationId: "investigation-1" },
    );

    await expect(server.callToolResult("search_events", {})).rejects.toBe(
      failure,
    );

    expect(JSON.parse(String(consoleError.mock.calls[0]?.[0]))).toEqual({
      durationMs: expect.any(Number),
      errorName: "MCPTransportError",
      event: "sentry_mcp_tool_call_failed",
      investigationId: "investigation-1",
      toolName: "search_events",
    });
  });

  it("combines tool and HTTP failure diagnostics into one event", async () => {
    const failure = new Error("sanitized transport failure");
    failure.name = "MCPTransportError";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 503 }),
    );
    const server = createSentryMcpServer(
      {
        accessToken: "sentry-test-token",
        mcpUrl: "https://mcp.sentry.dev/mcp/acme/api?skills=inspect",
        organizationSlug: "acme",
        projectSlug: "api",
      },
      { investigationId: "investigation-1" },
    );
    serverCallToolResult.mockImplementation(async () => {
      const fetchImpl = serverOptions.current?.fetch as typeof fetch;
      await fetchImpl("https://mcp.sentry.dev/mcp/acme?skills=inspect", {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "search_events" },
        }),
        method: "POST",
      });
      throw failure;
    });
    await expect(server.callToolResult("search_events", {})).rejects.toBe(
      failure,
    );

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(consoleError.mock.calls[0]?.[0]))).toEqual({
      durationMs: expect.any(Number),
      errorName: "MCPTransportError",
      event: "sentry_mcp_tool_call_failed",
      investigationId: "investigation-1",
      toolName: "search_events",
      transportFailureCount: 1,
      transportFailures: [
        {
          durationMs: expect.any(Number),
          kind: "http",
          mcpMethod: "tools/call",
          method: "POST",
          status: 503,
        },
      ],
    });
  });

  it("keeps every transport failure from a failed tool call", async () => {
    const failure = new Error("sanitized transport failure");
    failure.name = "MCPTransportError";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 504 }));
    const server = createSentryMcpServer(
      {
        accessToken: "sentry-test-token",
        mcpUrl: "https://mcp.sentry.dev/mcp/acme/api?skills=inspect",
        organizationSlug: "acme",
        projectSlug: "api",
      },
      { investigationId: "investigation-1" },
    );
    serverCallToolResult.mockImplementation(async () => {
      const fetchImpl = serverOptions.current?.fetch as typeof fetch;
      const request = {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "search_events" },
        }),
        method: "POST",
      };
      await fetchImpl("https://mcp.sentry.dev/mcp/acme?skills=inspect", request);
      await fetchImpl("https://mcp.sentry.dev/mcp/acme?skills=inspect", request);
      throw failure;
    });

    await expect(server.callToolResult("search_events", {})).rejects.toBe(
      failure,
    );

    expect(consoleError).toHaveBeenCalledTimes(1);
    const log = JSON.parse(String(consoleError.mock.calls[0]?.[0]));
    expect(log.transportFailureCount).toBe(2);
    expect(log.transportFailures).toEqual([
      expect.objectContaining({ kind: "http", status: 503 }),
      expect.objectContaining({ kind: "http", status: 504 }),
    ]);
  });

  it("logs transport failures when a tool retry recovers", async () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 503 }),
    );
    const server = createSentryMcpServer(
      {
        accessToken: "sentry-test-token",
        mcpUrl: "https://mcp.sentry.dev/mcp/acme/api?skills=inspect",
        organizationSlug: "acme",
        projectSlug: "api",
      },
      { investigationId: "investigation-1" },
    );
    serverCallToolResult.mockImplementation(async () => {
      const fetchImpl = serverOptions.current?.fetch as typeof fetch;
      await fetchImpl("https://mcp.sentry.dev/mcp/acme?skills=inspect", {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "search_events" },
        }),
        method: "POST",
      });
      return { content: [] };
    });

    await server.callToolResult("search_events", {});

    expect(consoleInfo).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(consoleInfo.mock.calls[0]?.[0]))).toEqual({
      durationMs: expect.any(Number),
      event: "sentry_mcp_tool_call_recovered",
      investigationId: "investigation-1",
      toolName: "search_events",
      transportFailureCount: 1,
      transportFailures: [
        expect.objectContaining({ kind: "http", status: 503 }),
      ],
    });
  });

  it("logs safe HTTP failure details without request arguments or response bodies", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("upstream secret response", {
        headers: {
          "retry-after": "10",
          "x-request-id": "upstream-request-1",
        },
        status: 503,
      }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const sentryFetch = createSentryMcpFetch(
      { investigationId: "investigation-1" },
      fetchImpl,
    );

    await sentryFetch("https://mcp.sentry.dev/mcp/acme?skills=inspect", {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { query: "customer secret" },
          name: "search_events",
        },
      }),
      headers: { authorization: "Sentry-Bearer sentry-test-token" },
      method: "POST",
    });

    const log = String(consoleError.mock.calls[0]?.[0]);
    expect(JSON.parse(log)).toEqual({
      durationMs: expect.any(Number),
      event: "sentry_mcp_http_error",
      investigationId: "investigation-1",
      kind: "http",
      mcpMethod: "tools/call",
      method: "POST",
      retryAfter: "10",
      status: 503,
      toolName: "search_events",
      upstreamRequestId: "upstream-request-1",
    });
    expect(log).not.toContain("customer secret");
    expect(log).not.toContain("sentry-test-token");
    expect(log).not.toContain("upstream secret response");
  });

  it("logs safe network error codes and rethrows the original failure", async () => {
    const cause = Object.assign(new Error("connect timed out"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const failure = Object.assign(new TypeError("fetch failed"), { cause });
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(failure);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const sentryFetch = createSentryMcpFetch(
      { investigationId: "investigation-2" },
      fetchImpl,
    );

    await expect(
      sentryFetch("https://mcp.sentry.dev/mcp/acme?skills=inspect", {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "get_sentry_resource" },
        }),
        method: "POST",
      }),
    ).rejects.toBe(failure);

    expect(JSON.parse(String(consoleError.mock.calls[0]?.[0]))).toEqual({
      causeCode: "UND_ERR_CONNECT_TIMEOUT",
      causeName: "Error",
      durationMs: expect.any(Number),
      errorName: "TypeError",
      event: "sentry_mcp_transport_error",
      investigationId: "investigation-2",
      kind: "network",
      mcpMethod: "tools/call",
      method: "POST",
      toolName: "get_sentry_resource",
    });
  });

  it("does not report an unsupported optional stream as a failure", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 405 }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const sentryFetch = createSentryMcpFetch(
      { investigationId: "investigation-3" },
      fetchImpl,
    );

    await sentryFetch("https://mcp.sentry.dev/mcp/acme?skills=inspect", {
      method: "GET",
    });

    expect(consoleError).not.toHaveBeenCalled();
  });
});
