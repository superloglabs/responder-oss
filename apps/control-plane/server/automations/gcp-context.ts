import { z } from "zod";
import {
  createGcpAuthClient,
  GCP_MCP_SERVICES,
  type GcpConnectionCredentials,
  type GcpMcpService,
} from "../../../../packages/core/src/integrations/gcp.js";

// Automation runs reach a Google Cloud project through the same keyless
// identity as investigations. The broker exposes only tools that Google marks
// read-only, matching the investigation tool filter, and refuses the rest.

const TOOL_CACHE_TTL_MS = 10 * 60 * 1_000;
const MAX_CACHED_CLIENTS = 200;
const MAX_TOOL_PAGES = 10;
const PROTOCOL_VERSION = "2025-03-26";

// Methods forwarded to Google besides notifications. tools/list is answered by
// the broker itself.
const forwardedMethods = new Set(["initialize", "ping", "tools/call"]);

export interface McpTool {
  annotations?: { readOnlyHint?: boolean };
  name: string;
  [key: string]: unknown;
}

export interface GcpContextDependencies {
  authHeaders: (connection: GcpConnectionCredentials) => Promise<Headers>;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  now: () => number;
}

export function isGcpMcpService(value: string | undefined): value is GcpMcpService {
  return value !== undefined && Object.hasOwn(GCP_MCP_SERVICES, value);
}

const authClients = new Map<string, ReturnType<typeof createGcpAuthClient>>();

/** Federated Google credentials for one connection, refreshed by the client. */
export async function gcpAuthHeaders(
  connection: GcpConnectionCredentials,
): Promise<Headers> {
  const key = `${connection.projectNumber}:${connection.sessionName}`;
  let client = authClients.get(key);
  if (!client) {
    client = createGcpAuthClient(connection);
    authClients.set(key, client);
    if (authClients.size > MAX_CACHED_CLIENTS) {
      authClients.delete(authClients.keys().next().value!);
    }
  }
  const headers = new Headers();
  for (const [name, value] of await client.getRequestHeaders()) {
    headers.set(name, value);
  }
  headers.set("x-goog-user-project", connection.projectId);
  return headers;
}

const rpcResponseSchema = z.object({
  error: z.object({ message: z.string().optional() }).passthrough().optional(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  result: z.unknown().optional(),
});

// Streamable HTTP servers may answer with JSON or with a server-sent event
// stream that carries the JSON-RPC response.
async function readRpcResponse(
  response: Response,
  id: string,
): Promise<z.infer<typeof rpcResponseSchema>> {
  if (!response.ok) {
    throw new Error(`Google Cloud MCP returned HTTP ${response.status}`);
  }
  const text = await response.text();
  const messages = (response.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split(/\r?\n\r?\n/u).flatMap((event) => {
        const data = event
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        return data ? [JSON.parse(data) as unknown] : [];
      })
    : [JSON.parse(text) as unknown];
  for (const message of messages) {
    const parsed = rpcResponseSchema.safeParse(message);
    if (parsed.success && parsed.data.id === id) {
      if (parsed.data.error) {
        throw new Error(
          `Google Cloud MCP error: ${parsed.data.error.message ?? "unknown error"}`,
        );
      }
      return parsed.data;
    }
  }
  throw new Error("Google Cloud MCP response did not answer the request");
}

const toolCache = new Map<string, { expiresAt: number; tools: McpTool[] }>();

/** The read-only tools one Google MCP server offers this connection. */
export async function readOnlyGcpTools(input: {
  accountId: string;
  connection: GcpConnectionCredentials;
  dependencies: GcpContextDependencies;
  service: GcpMcpService;
  signal: AbortSignal;
}): Promise<McpTool[]> {
  const key = `${input.accountId}:${input.connection.sessionName}:${input.service}`;
  const cached = toolCache.get(key);
  if (cached && cached.expiresAt > input.dependencies.now()) return cached.tools;

  const url = GCP_MCP_SERVICES[input.service];
  const headers = await input.dependencies.authHeaders(input.connection);
  headers.set("accept", "application/json, text/event-stream");
  headers.set("content-type", "application/json");
  const send = (body: Record<string, unknown>) =>
    input.dependencies.fetch(url, {
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      headers,
      method: "POST",
      signal: input.signal,
    });

  // The broker lists tools in a short session of its own, so a run can never
  // see the unfiltered list.
  const initialize = await send({
    id: "responder-initialize",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "responder-context-broker", version: "1" },
      protocolVersion: PROTOCOL_VERSION,
    },
  });
  const sessionId = initialize.headers.get("mcp-session-id");
  const initialized = await readRpcResponse(initialize, "responder-initialize");
  if (sessionId) headers.set("mcp-session-id", sessionId);
  const protocolVersion = z.object({ protocolVersion: z.string() })
    .safeParse(initialized.result);
  headers.set(
    "mcp-protocol-version",
    protocolVersion.success ? protocolVersion.data.protocolVersion : PROTOCOL_VERSION,
  );
  await (await send({ method: "notifications/initialized" })).body?.cancel();

  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const id = `responder-tools-${page}`;
    const listed = z.object({
      nextCursor: z.string().optional(),
      tools: z.array(z.object({ name: z.string().min(1) }).passthrough()),
    }).parse((await readRpcResponse(
      await send({ id, method: "tools/list", params: cursor ? { cursor } : {} }),
      id,
    )).result);
    tools.push(...(listed.tools as McpTool[]));
    cursor = listed.nextCursor || undefined;
    if (!cursor) break;
  }

  const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true);
  toolCache.set(key, {
    expiresAt: input.dependencies.now() + TOOL_CACHE_TTL_MS,
    tools: readOnly,
  });
  return readOnly;
}

export type GcpContextDecision =
  | { kind: "forward" }
  | { kind: "list"; tools: McpTool[] }
  | { code: number; kind: "reject"; message: string; status: 400 | 404 };

/** Decides how the broker answers one MCP request for a Google service. */
export async function gcpContextDecision(input: {
  accountId: string;
  connection: GcpConnectionCredentials;
  dependencies: GcpContextDependencies;
  method: string;
  params: Record<string, unknown> | undefined;
  service: GcpMcpService;
  signal: AbortSignal;
}): Promise<GcpContextDecision> {
  if (input.method === "tools/list") {
    return { kind: "list", tools: await readOnlyGcpTools(input) };
  }
  if (input.method.startsWith("notifications/")) return { kind: "forward" };
  if (!forwardedMethods.has(input.method)) {
    return { code: -32601, kind: "reject", message: "Method not found", status: 404 };
  }
  if (input.method === "tools/call") {
    const name = z.string().safeParse(input.params?.name);
    const tools = await readOnlyGcpTools(input);
    if (!name.success || !tools.some((tool) => tool.name === name.data)) {
      return {
        code: -32602,
        kind: "reject",
        message: "Unknown or non-read-only tool",
        status: 400,
      };
    }
  }
  return { kind: "forward" };
}
