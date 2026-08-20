import { describe, expect, it, vi } from "vitest";
import type { MCPServer } from "@openai/agents";
import type { RuntimeLangfuseConnection } from "@responder/core/db/investigations";
import {
  LANGFUSE_CONTEXT_MCP_TOOLS,
  ScopedLangfuseMcpServer,
  langfuseMcpHeaders,
  normalizedLangfuseArgs,
  sanitizeLangfuseOutput,
} from "./langfuse.js";

const connection: RuntimeLangfuseConnection = {
  accountId: "account-1",
  baseUrl: "https://cloud.langfuse.com",
  displayName: "Example / Production",
  projectId: "project-1",
  publicKey: "pk-lf-public-key",
  secretKey: "sk-lf-secret-key",
};

function fakeServer(): MCPServer {
  return {
    cacheToolsList: true,
    name: "langfuse-upstream",
    useStructuredContent: true,
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    invalidateToolsCache: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([
      { name: "listObservations", inputSchema: { type: "object" } },
      { name: "createScore", inputSchema: { type: "object" } },
    ]),
    callTool: vi.fn().mockResolvedValue(
      Object.assign(
        [{ type: "text", text: "sk-lf-secret-key" }],
        { structuredContent: { apiKey: "pk-lf-public-key", ok: true } },
      ),
    ),
  } as unknown as MCPServer;
}

describe("Langfuse investigation context", () => {
  it("uses project keys through a Basic authorization header", () => {
    expect(langfuseMcpHeaders(connection)).toEqual({
      authorization: `Basic ${Buffer.from(
        "pk-lf-public-key:sk-lf-secret-key",
      ).toString("base64")}`,
    });
  });

  it("contains only explicitly reviewed read tools", () => {
    expect(LANGFUSE_CONTEXT_MCP_TOOLS).toContain("listObservations");
    expect(LANGFUSE_CONTEXT_MCP_TOOLS).toContain("queryMetrics");
    expect(LANGFUSE_CONTEXT_MCP_TOOLS).not.toContain("createScore");
    expect(LANGFUSE_CONTEXT_MCP_TOOLS).not.toContain("createTextPrompt");
    expect(LANGFUSE_CONTEXT_MCP_TOOLS).not.toContain("deleteDatasetItem");
  });

  it("defaults unscoped observation searches to the last 24 hours", () => {
    expect(
      normalizedLangfuseArgs(
        "listObservations",
        {},
        new Date("2026-08-19T12:00:00.000Z"),
      ),
    ).toEqual({
      fromStartTime: "2026-08-18T12:00:00.000Z",
      limit: 50,
      toStartTime: "2026-08-19T12:00:00.000Z",
    });
  });

  it("redacts credential-shaped output", () => {
    expect(
      sanitizeLangfuseOutput(
        {
          nested: "value sk-lf-secret-key",
          token: "provider-token",
        },
        ["sk-lf-secret-key"],
      ),
    ).toEqual({ nested: "value [redacted]", token: "[redacted]" });
  });

  it("redacts short secrets and sensitive fields inside serialized JSON", () => {
    expect(
      sanitizeLangfuseOutput(
        JSON.stringify({ nested: { apiKey: "provider-key" }, value: "key=abc" }),
        ["abc"],
      ),
    ).toBe(
      JSON.stringify({ nested: { apiKey: "[redacted]" }, value: "key=[redacted]" }),
    );
  });

  it("filters tool discovery and rejects direct write calls", async () => {
    const server = new ScopedLangfuseMcpServer(fakeServer(), connection);
    await expect(server.listTools()).resolves.toEqual([
      { name: "listObservations", inputSchema: { type: "object" } },
    ]);
    await expect(server.callTool("createScore", {})).rejects.toThrow(
      "not available during investigations",
    );
  });

  it("redacts keys returned by the upstream server", async () => {
    const server = new ScopedLangfuseMcpServer(fakeServer(), connection);
    const result = await server.callTool("getObservation", {
      observationId: "observation-1",
    });
    expect(result[0]).toMatchObject({ text: "[redacted]" });
    expect(result.structuredContent).toEqual({ apiKey: "[redacted]", ok: true });
  });
});
