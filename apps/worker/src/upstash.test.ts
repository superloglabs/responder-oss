import type { MCPServer } from "@openai/agents";
import type { RuntimeUpstashConnection } from "@responder/core/db/investigations";
import { describe, expect, it, vi } from "vitest";
import {
  createUpstashCliTools,
  sanitizeUpstashOutput,
  ScopedUpstashMcpServer,
  upstashInspectionArgs,
  validateUpstashRedisCommands,
} from "./upstash.js";

const connection: RuntimeUpstashConnection = {
  accountId: "account-1",
  apiKey: "developer-api-key",
  displayName: "operator@example.com",
  email: "operator@example.com",
};

function upstreamServer() {
  const result = [{
    type: "text",
    text: JSON.stringify({ database_id: "db-1", rest_token: "db-secret" }),
  }];
  Object.assign(result, {
    structuredContent: { api_key: "developer-api-key", count: 1 },
  });
  const callTool = vi.fn().mockResolvedValue(result);
  const server = {
    cacheToolsList: true,
    callTool,
    close: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    invalidateToolsCache: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([
      {
        name: "workflow_logs_list",
        inputSchema: {
          properties: {
            local_mode_port: { type: "number" },
            qstash_creds: { type: "object" },
            region: { enum: ["eu", "us", "local"] },
          },
          type: "object",
        },
      },
      {
        name: "redis_database_run_redis_commands",
        inputSchema: {
          properties: {
            commands: { type: "array" },
            database_id: { type: "string" },
            database_rest_token: { type: "string" },
            database_rest_url: { type: "string" },
          },
          type: "object",
        },
      },
      { name: "redis_database_delete" },
      { name: "qstash_schedule_create" },
    ]),
    name: "upstash-upstream",
  } as unknown as MCPServer;
  return { callTool, server };
}

describe("Upstash investigation context", () => {
  it("exposes Workflow and read-only Redis tools but no mutation tools", async () => {
    const { server } = upstreamServer();
    const scoped = new ScopedUpstashMcpServer(server, connection);

    await expect(scoped.listTools()).resolves.toEqual([
      expect.objectContaining({
        name: "workflow_logs_list",
        inputSchema: expect.objectContaining({
          properties: {
            region: expect.objectContaining({ enum: ["eu", "us"] }),
          },
        }),
      }),
      expect.objectContaining({
        name: "redis_database_run_redis_commands",
        inputSchema: expect.objectContaining({
          properties: {
            commands: { type: "array" },
            database_id: { type: "string" },
          },
        }),
      }),
    ]);
  });

  it("blocks MCP mutation tools even when called directly", async () => {
    const { callTool, server } = upstreamServer();
    const scoped = new ScopedUpstashMcpServer(server, connection);

    await expect(
      scoped.callTool("redis_database_delete", { database_id: "db-1" }),
    ).rejects.toThrow("not available during investigations");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("blocks custom and local QStash endpoints before dispatch", async () => {
    const { callTool, server } = upstreamServer();
    const scoped = new ScopedUpstashMcpServer(server, connection);

    await expect(
      scoped.callTool("workflow_logs_list", { region: "local" }),
    ).rejects.toThrow("Only Upstash EU and US QStash regions are allowed");
    await expect(
      scoped.callTool("qstash_logs_list", {
        qstash_creds: { token: "other-token", url: "https://example.com" },
      }),
    ).rejects.toThrow("Custom QStash endpoints and credentials are not accepted");
    await expect(
      scoped.callTool("workflow_dlq_list", { count: 101, region: "eu" }),
    ).rejects.toThrow("limited to 100 items");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("allows bounded Redis reads and rejects writes before dispatch", async () => {
    expect(() =>
      validateUpstashRedisCommands({
        database_id: "db-1",
        commands: [["SCAN", "0", "COUNT", "100"], ["GET", "status"]],
      }),
    ).not.toThrow();
    expect(() =>
      validateUpstashRedisCommands({
        database_id: "db-1",
        commands: [["SET", "status", "ok"]],
      }),
    ).toThrow("Redis command SET is not allowed");
    expect(() =>
      validateUpstashRedisCommands({
        database_rest_token: "direct-token",
        database_rest_url: "https://example.upstash.io",
        commands: [["GET", "status"]],
      }),
    ).toThrow("database_id is required");

    const { callTool, server } = upstreamServer();
    const scoped = new ScopedUpstashMcpServer(server, connection);
    await expect(
      scoped.callTool("redis_database_get_statistics", {
        database_id: "../../qstash/user",
      }),
    ).rejects.toThrow("database_id is invalid");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("redacts provider credentials from nested CLI and MCP output", async () => {
    expect(
      sanitizeUpstashOutput({
        api_key: "developer-api-key",
        nested: {
          headers: { authorization: "Bearer destination-secret" },
          read_only_rest_token: "db-secret",
          value: "safe",
        },
      }, ["developer-api-key"]),
    ).toEqual({
      api_key: "[redacted]",
      nested: {
        headers: "[redacted]",
        read_only_rest_token: "[redacted]",
        value: "safe",
      },
    });

    const { server } = upstreamServer();
    const result = await new ScopedUpstashMcpServer(
      server,
      connection,
    ).callTool("workflow_logs_list", {});
    expect(JSON.stringify(result)).not.toContain("developer-api-key");
    expect(JSON.stringify(result)).not.toContain("db-secret");
    expect(JSON.stringify(result)).toContain("[redacted]");
  });

  it("maps CLI inspection requests to fixed read-only commands", async () => {
    expect(
      upstashInspectionArgs({
        period: "7d",
        resourceId: "index-1",
        resourceType: "vector",
        view: "statistics",
      }),
    ).toEqual([
      "vector",
      "index-stats",
      "--index-id",
      "index-1",
      "--period",
      "7d",
    ]);
    expect(() =>
      upstashInspectionArgs({
        period: "1h",
        resourceId: "team-1",
        resourceType: "team",
        view: "details",
      }),
    ).toThrow("details is not available for team resources");
    expect(() =>
      upstashInspectionArgs({
        period: "1h",
        resourceId: "../../qstash/user",
        resourceType: "redis",
        view: "details",
      }),
    ).toThrow("resource ID is invalid");

    const runner = vi.fn().mockResolvedValue([]);
    const tools = createUpstashCliTools(connection, runner);
    await tools[0]!.invoke(
      undefined as never,
      JSON.stringify({ resourceType: "qstash" }),
    );
    expect(runner).toHaveBeenCalledWith(["qstash", "list"], connection);
  });
});
