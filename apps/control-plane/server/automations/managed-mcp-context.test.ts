import { describe, expect, it, vi } from "vitest";
import {
  allowedManagedMcpTools,
  managedMcpDecision,
  type ManagedMcpServer,
} from "./managed-mcp-context.js";

let serverNumber = 0;

function server(
  respond: (body: { id?: string; method: string; params?: { cursor?: string } }) => Response,
): ManagedMcpServer & { fetch: ReturnType<typeof vi.fn> } {
  serverNumber += 1;
  return {
    cacheKey: `test:${serverNumber}`,
    fetch: vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id?: string; method: string };
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return respond(body);
    }),
    headers: async () => new Headers(),
    isAllowed: (tool) => tool.annotations?.readOnlyHint === true,
    label: "Test MCP",
    now: () => Date.now(),
    url: "https://mcp.example/mcp",
  };
}

function result(id: string | undefined, value: unknown) {
  return Response.json({ id, jsonrpc: "2.0", result: value });
}

const readOnly = { annotations: { readOnlyHint: true }, name: "read_logs" };

describe("managed MCP tool listing", () => {
  it("reads event streams with any media type case and CR line endings", async () => {
    const target = server((body) => new Response(
      `event: message\rdata: ${JSON.stringify({
        id: body.id,
        jsonrpc: "2.0",
        result: body.method === "initialize" ? {} : { tools: [readOnly] },
      })}\r\r`,
      { headers: { "content-type": "Text/Event-Stream" } },
    ));

    const tools = await allowedManagedMcpTools(target);

    expect(tools.map((tool) => tool.name)).toEqual(["read_logs"]);
  });

  it("lists once for concurrent requests on a cold cache", async () => {
    const target = server((body) =>
      result(body.id, body.method === "initialize" ? {} : { tools: [readOnly] }));

    await Promise.all([
      allowedManagedMcpTools(target),
      allowedManagedMcpTools(target),
    ]);

    const methods = target.fetch.mock.calls.map(([, init]) =>
      (JSON.parse(String((init as RequestInit).body)) as { method: string }).method);
    expect(methods.filter((method) => method === "initialize")).toHaveLength(1);
  });

  it("fails instead of caching a listing cut off at the page limit", async () => {
    const target = server((body) =>
      result(body.id, body.method === "initialize"
        ? {}
        : { nextCursor: "more", tools: [readOnly] }));

    await expect(allowedManagedMcpTools(target)).rejects.toThrow(/page/u);
    await expect(allowedManagedMcpTools(target)).rejects.toThrow(/page/u);

    const methods = target.fetch.mock.calls.map(([, init]) =>
      (JSON.parse(String((init as RequestInit).body)) as { method: string }).method);
    expect(methods.filter((method) => method === "initialize")).toHaveLength(2);
  });
});

describe("managed MCP decisions", () => {
  it("forwards session notifications and drops the others", async () => {
    const target = server(() => new Response(null, { status: 500 }));
    const decide = (method: string) => managedMcpDecision({
      method,
      params: undefined,
      server: target,
    });

    await expect(decide("notifications/initialized")).resolves.toEqual({ kind: "forward" });
    await expect(decide("notifications/cancelled")).resolves.toEqual({ kind: "forward" });
    await expect(decide("notifications/roots/list_changed")).resolves.toEqual({ kind: "accept" });
    expect(target.fetch).not.toHaveBeenCalled();
  });
});
