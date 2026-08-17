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
            count: { type: "number" },
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
            count: expect.objectContaining({ default: 10, maximum: 10 }),
            region: expect.objectContaining({ enum: ["eu", "us"] }),
          },
        }),
      }),
      expect.objectContaining({
        name: "redis_database_run_redis_commands",
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            commands: { type: "array" },
            database_id: expect.objectContaining({ type: "string" }),
          }),
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
    await expect(
      scoped.callTool("workflow_logs_list", { count: 11, region: "eu" }),
    ).rejects.toThrow("limited to 10 items");
    await expect(
      scoped.callTool("qstash_logs_list", { cursor: "x".repeat(4_097) }),
    ).rejects.toThrow("cursor is invalid");
    await expect(
      scoped.callTool("workflow_logs_list", { workflowUrl: "file:///tmp/log" }),
    ).rejects.toThrow("workflowUrl is invalid");
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
        commands: [["SCAN", "0"]],
      }),
    ).toThrow("requires a bounded COUNT");
    expect(() =>
      validateUpstashRedisCommands({
        database_id: "db-1",
        commands: [["SET", "status", "ok"]],
      }),
    ).toThrow("Redis command SET is not allowed");
    expect(() =>
      validateUpstashRedisCommands({
        database_id: "db-1",
        commands: [["PFCOUNT", "visitors"]],
      }),
    ).toThrow("Redis command PFCOUNT is not allowed");
    expect(() =>
      validateUpstashRedisCommands({
        database_id: "db-1",
        commands: [["LRANGE", "events", "0", "100"]],
      }),
    ).toThrow("range is limited to 100 items");
    expect(() =>
      validateUpstashRedisCommands({
        database_id: "db-1",
        commands: [["LRANGE", "events", "-100", "-1"]],
      }),
    ).not.toThrow();
    expect(() =>
      validateUpstashRedisCommands({
        database_id: "db-1",
        commands: [["LRANGE", "events", "0", "-1"]],
      }),
    ).toThrow("range is limited to 100 items");
    expect(() =>
      validateUpstashRedisCommands({
        database_id: "db-1",
        commands: [["XRANGE", "events", "-", "+"]],
      }),
    ).toThrow("requires a bounded COUNT");
    expect(() =>
      validateUpstashRedisCommands({
        database_id: "db-1",
        commands: [["XRANGE", "events", "-", "+", "COUNT", "100"]],
      }),
    ).not.toThrow();
    expect(() =>
      validateUpstashRedisCommands({
        database_id: "db-1",
        commands: [["XRANGE", "COUNT", "1", "100"]],
      }),
    ).toThrow("requires a bounded COUNT");
    expect(() =>
      validateUpstashRedisCommands({
        database_id: "db-1",
        commands: [["ZRANGEBYSCORE", "LIMIT", "0", "100"]],
      }),
    ).toThrow("requires a bounded LIMIT");
    expect(() =>
      validateUpstashRedisCommands({
        database_id: "db-1",
        commands: [["GEOSEARCH", "places", "FROMMEMBER", "here", "BYRADIUS", "5", "km", "COUNT", "100", "ANY"]],
      }),
    ).not.toThrow();
    expect(() =>
      validateUpstashRedisCommands({
        database_id: "db-1",
        commands: [["GEOSEARCH", "places", "FROMMEMBER", "here", "BYRADIUS", "5", "km", "COUNT", "100"]],
      }),
    ).toThrow("requires COUNT with ANY");
    expect(() =>
      validateUpstashRedisCommands({
        database_id: "db-1",
        commands: [["GETRANGE", "payload", "0", "65535"]],
      }),
    ).not.toThrow();
    expect(() =>
      validateUpstashRedisCommands({
        database_id: "db-1",
        commands: [["GETRANGE", "payload", "0", "65536"]],
      }),
    ).toThrow("limited to 64 KiB");
    expect(() =>
      validateUpstashRedisCommands({
        database_id: "db-1",
        commands: [["GETRANGE", "payload", "-65536", "-1"]],
      }),
    ).not.toThrow();
    expect(() =>
      validateUpstashRedisCommands({
        database_id: "db-1",
        commands: [["XINFO", "STREAM", "events"]],
      }),
    ).not.toThrow();
    expect(() =>
      validateUpstashRedisCommands({
        database_id: "db-1",
        commands: [["XINFO", "GROUPS", "events"]],
      }),
    ).toThrow("Only bounded XINFO STREAM");
    expect(() =>
      validateUpstashRedisCommands({
        database_id: "db-1",
        commands: [["MEMORY", "USAGE", "cache", "SAMPLES", "100"]],
      }),
    ).not.toThrow();
    expect(() =>
      validateUpstashRedisCommands({
        database_id: "db-1",
        commands: [["MEMORY", "USAGE", "cache", "SAMPLES", "0"]],
      }),
    ).toThrow("samples are limited to 100");
    for (const command of [
      "HGETALL",
      "HKEYS",
      "HVALS",
      "JSON.OBJKEYS",
      "SMEMBERS",
    ]) {
      expect(() =>
        validateUpstashRedisCommands({
          database_id: "db-1",
          commands: [[command, "collection"]],
        }),
      ).toThrow(`Redis command ${command} is not allowed`);
    }
    expect(() =>
      validateUpstashRedisCommands({
        database_id: "db-1",
        commands: Array.from({ length: 20 }, () => [
          "MGET",
          ...Array.from({ length: 20 }, () => "界".repeat(1_000)),
        ]),
      }),
    ).toThrow("exceed the 64 KiB request limit");
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
        id: "../../qstash/user",
        period: "1h",
      }),
    ).rejects.toThrow("id is invalid");
    expect(callTool).not.toHaveBeenCalled();

    await scoped.callTool("redis_database_get_statistics", {
      id: "db-1",
      period: "1h",
    });
    expect(callTool).toHaveBeenCalledWith(
      "redis_database_get_statistics",
      { id: "db-1", period: "1h" },
      undefined,
      undefined,
    );
  });

  it("bounds utility and QStash filter inputs without rejecting opaque cursors", async () => {
    const { callTool, server } = upstreamServer();
    const scoped = new ScopedUpstashMcpServer(server, connection);

    await expect(
      scoped.callTool("util_dates_to_timestamps", {
        dates: Array.from({ length: 101 }, () => "2026-08-17"),
      }),
    ).rejects.toThrow("limited to 100 values");
    await expect(
      scoped.callTool("util_timestamps_to_date", {
        timestamps: Array.from({ length: 101 }, (_, index) => index),
      }),
    ).rejects.toThrow("limited to 100 values");
    await scoped.callTool("qstash_logs_list", {
      cursor: "opaque/+/cursor==",
      url: "http://service.example/jobs?id=123",
    });
    expect(callTool).toHaveBeenCalledWith(
      "qstash_logs_list",
      {
        count: 25,
        cursor: "opaque/+/cursor==",
        url: "http://service.example/jobs?id=123",
      },
      undefined,
      undefined,
    );

    await scoped.callTool("workflow_logs_list", {});
    expect(callTool).toHaveBeenLastCalledWith(
      "workflow_logs_list",
      { count: 10 },
      undefined,
      undefined,
    );
  });

  it("limits aggregate Upstash child operations to two", async () => {
    const { callTool, server } = upstreamServer();
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    callTool.mockImplementation(
      () =>
        new Promise((resolve) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          releases.push(() => {
            active -= 1;
            resolve([]);
          });
        }),
    );
    const scoped = new ScopedUpstashMcpServer(server, connection);
    const calls = Array.from({ length: 4 }, () =>
      scoped.callTool("workflow_logs_list", {}),
    );

    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(3));
    releases.shift()?.();
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(4));
    while (releases.length > 0) releases.shift()?.();
    await Promise.all(calls);

    expect(maximumActive).toBe(2);
  });

  it("redacts provider credentials from nested CLI and MCP output", async () => {
    expect(
      sanitizeUpstashOutput({
        api_key: "developer-api-key",
        nested: {
          headers: { authorization: "Bearer destination-secret" },
          jwt: "signed-token",
          privateKey: "private-key",
          read_only_rest_token: "db-secret",
          session_id: "session-secret",
          signing_key: "signing-key",
          webhookSignature: "webhook-signature",
          value: "safe",
        },
      }, ["developer-api-key"]),
    ).toEqual({
      api_key: "[redacted]",
      nested: {
        headers: "[redacted]",
        jwt: "[redacted]",
        privateKey: "[redacted]",
        read_only_rest_token: "[redacted]",
        session_id: "[redacted]",
        signing_key: "[redacted]",
        webhookSignature: "[redacted]",
        value: "safe",
      },
    });

    const sanitizedUrls = sanitizeUpstashOutput({
      callback:
        "https://user:password@example.com/hook?signature=secret-signature&event=failed#token-fragment",
      databaseDsn: "redis://default:redis-password@example.upstash.io:6379/0",
      destination: "https://example.com/jobs?key=secret-key&job=123",
    }) as Record<string, string>;
    expect(sanitizedUrls.callback).not.toContain("user:password");
    expect(sanitizedUrls.callback).not.toContain("secret-signature");
    expect(sanitizedUrls.callback).not.toContain("token-fragment");
    expect(new URL(sanitizedUrls.callback).searchParams.get("event")).toBe(
      "failed",
    );
    expect(sanitizedUrls.databaseDsn).toBe("[redacted]");
    expect(sanitizedUrls.destination).not.toContain("secret-key");
    expect(new URL(sanitizedUrls.destination).searchParams.get("job")).toBe(
      "123",
    );

    const compoundParameters = new URL(
      sanitizeUpstashOutput(
        "https://example.com/callback?client_secret=s&refresh_token=t&x-api-key=k&request_id=req-1",
      ) as string,
    );
    expect(compoundParameters.searchParams.get("client_secret")).toContain(
      "redacted",
    );
    expect(compoundParameters.searchParams.get("refresh_token")).toContain(
      "redacted",
    );
    expect(compoundParameters.searchParams.get("x-api-key")).toContain(
      "redacted",
    );
    expect(compoundParameters.searchParams.get("request_id")).toBe("req-1");

    const unstructured = sanitizeUpstashOutput(
      "inspection failed: dsn=dsn-value jwt:jwt-value " +
        "privateKey=private-value session_id=session-value " +
        "signing-key=signing-value webhookSignature=signature-value " +
        "diagnostic=preserved",
    ) as string;
    expect(unstructured).not.toContain("dsn-value");
    expect(unstructured).not.toContain("jwt-value");
    expect(unstructured).not.toContain("private-value");
    expect(unstructured).not.toContain("session-value");
    expect(unstructured).not.toContain("signing-value");
    expect(unstructured).not.toContain("signature-value");
    expect(unstructured).toContain("diagnostic=preserved");

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
    expect(() =>
      upstashInspectionArgs({
        period: "1h",
        resourceId: "--output=/tmp/result",
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
