import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import {
  grafanaSelfHostedProcess,
  isGrafanaReadOnlyTool,
} from "../../../../packages/core/src/integrations/grafana-mcp.js";
import {
  cachedMcpTools,
  MAX_TOOL_PAGES,
  type ManagedMcpServer,
  type McpTool,
} from "./managed-mcp-context.js";

// Automation runs reach Grafana through the broker with the same read-only
// rule as investigations: only tools the server annotates read-only are
// listed or callable. Grafana Cloud's hosted MCP server is proxied like the
// other managed servers. Self-hosted Grafana is served by the pinned
// mcp-grafana binary, started for each listing or call, so the service account
// token stays on the server.

const CALL_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = "2025-03-26";

/** Grafana Cloud's hosted MCP server as the broker reaches it for a connection. */
export function grafanaCloudContextServer(input: {
  accessToken: () => Promise<string>;
  accountId: string;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  mcpUrl: string;
  now: () => number;
}): ManagedMcpServer {
  return {
    cacheKey: `grafana:${input.accountId}:${input.mcpUrl}`,
    fetch: input.fetch,
    headers: async () => new Headers({
      authorization: `Bearer ${await input.accessToken()}`,
    }),
    isAllowed: isGrafanaReadOnlyTool,
    label: "Grafana Cloud MCP",
    now: input.now,
    url: input.mcpUrl,
  };
}

export type GrafanaMcpClient = Pick<Client, "callTool" | "close" | "listTools">;

export interface SelfHostedGrafanaDependencies {
  connect: (
    connection: SelfHostedGrafanaConnection,
    signal?: AbortSignal,
  ) => Promise<GrafanaMcpClient>;
  now: () => number;
}

export interface SelfHostedGrafanaConnection {
  grafanaUrl: string;
  serviceAccountToken: string;
}

async function connectSelfHostedGrafana(
  connection: SelfHostedGrafanaConnection,
  signal?: AbortSignal,
): Promise<GrafanaMcpClient> {
  const client = new Client({ name: "responder-context-broker", version: "1" });
  await client.connect(
    new StdioClientTransport(await grafanaSelfHostedProcess(connection)),
    { signal, timeout: CONNECT_TIMEOUT_MS },
  );
  return client;
}

export const defaultSelfHostedGrafanaDependencies: SelfHostedGrafanaDependencies = {
  connect: connectSelfHostedGrafana,
  now: Date.now,
};

async function withClient<T>(
  connection: SelfHostedGrafanaConnection,
  dependencies: SelfHostedGrafanaDependencies,
  signal: AbortSignal | undefined,
  operation: (client: GrafanaMcpClient) => Promise<T>,
): Promise<T> {
  const client = await dependencies.connect(connection, signal);
  try {
    return await operation(client);
  } finally {
    await client.close().catch(() => {});
  }
}

function allowedSelfHostedTools(input: {
  accountId: string;
  connection: SelfHostedGrafanaConnection;
  dependencies: SelfHostedGrafanaDependencies;
}): Promise<McpTool[]> {
  return cachedMcpTools({
    cacheKey: `grafana:${input.accountId}:${input.connection.grafanaUrl}`,
    load: () => withClient(input.connection, input.dependencies, undefined, async (client) => {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; ; page += 1) {
        // A cut-off listing would hide tools, so it fails instead.
        if (page === MAX_TOOL_PAGES) {
          throw new Error(`mcp-grafana listed tools on more than ${MAX_TOOL_PAGES} pages`);
        }
        const listed = await client.listTools(cursor ? { cursor } : {}, {
          timeout: CONNECT_TIMEOUT_MS,
        });
        tools.push(...(listed.tools as McpTool[]));
        cursor = listed.nextCursor || undefined;
        if (!cursor) break;
      }
      return tools.filter(isGrafanaReadOnlyTool);
    }),
    now: input.dependencies.now(),
  });
}

export type SelfHostedGrafanaAnswer =
  | { kind: "accept" }
  | { kind: "result"; result: unknown }
  | { code: number; kind: "reject"; message: string; status: 400 | 404 };

/** Answers one MCP request for a self-hosted Grafana connection. */
export async function selfHostedGrafanaAnswer(input: {
  accountId: string;
  connection: SelfHostedGrafanaConnection;
  dependencies: SelfHostedGrafanaDependencies;
  method: string;
  params: Record<string, unknown> | undefined;
  signal: AbortSignal;
}): Promise<SelfHostedGrafanaAnswer> {
  if (input.method.startsWith("notifications/")) return { kind: "accept" };
  if (input.method === "initialize") {
    const requestedVersion = z.string().safeParse(input.params?.protocolVersion);
    return {
      kind: "result",
      result: {
        capabilities: { tools: {} },
        protocolVersion: requestedVersion.success ? requestedVersion.data : PROTOCOL_VERSION,
        serverInfo: { name: "responder-grafana", version: "1" },
      },
    };
  }
  if (input.method === "ping") return { kind: "result", result: {} };
  if (input.method === "tools/list") {
    return { kind: "result", result: { tools: await allowedSelfHostedTools(input) } };
  }
  if (input.method !== "tools/call") {
    return { code: -32601, kind: "reject", message: "Method not found", status: 404 };
  }
  const name = z.string().safeParse(input.params?.name);
  const tools = await allowedSelfHostedTools(input);
  if (!name.success || !tools.some((tool) => tool.name === name.data)) {
    return {
      code: -32602,
      kind: "reject",
      message: "Unknown or non-read-only tool",
      status: 400,
    };
  }
  const args = z.record(z.string(), z.unknown()).optional().safeParse(input.params?.arguments);
  if (!args.success) {
    return { code: -32602, kind: "reject", message: "Invalid tool arguments", status: 400 };
  }
  return {
    kind: "result",
    result: await withClient(input.connection, input.dependencies, input.signal, (client) =>
      client.callTool(
        { arguments: args.data, name: name.data },
        undefined,
        { signal: input.signal, timeout: CALL_TIMEOUT_MS },
      )),
  };
}
