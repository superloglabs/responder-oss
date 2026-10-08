import { z } from "zod";

// Cloud providers' managed MCP servers mark which tools only read. The broker
// lists tools itself, exposes only the ones a provider's rule allows, and
// refuses calls to any other tool or MCP method.

const TOOL_CACHE_TTL_MS = 10 * 60 * 1_000;
const MAX_TOOL_PAGES = 10;
const PROTOCOL_VERSION = "2025-03-26";

// Methods forwarded to the provider besides notifications. tools/list is
// answered by the broker itself.
const forwardedMethods = new Set(["initialize", "ping", "tools/call"]);

export interface McpTool {
  annotations?: { readOnlyHint?: boolean };
  name: string;
  [key: string]: unknown;
}

export interface ManagedMcpServer {
  // Identifies one connection's tool listing on one server.
  cacheKey: string;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  headers: () => Promise<Headers>;
  isAllowed: (tool: McpTool) => boolean;
  // Names the provider in errors, for example "Google Cloud MCP".
  label: string;
  now: () => number;
  url: string;
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
  label: string,
): Promise<z.infer<typeof rpcResponseSchema>> {
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
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
        throw new Error(`${label} error: ${parsed.data.error.message ?? "unknown error"}`);
      }
      return parsed.data;
    }
  }
  throw new Error(`${label} response did not answer the request`);
}

const toolCache = new Map<string, { expiresAt: number; tools: McpTool[] }>();

/** The tools a managed MCP server offers that its provider's rule allows. */
export async function allowedManagedMcpTools(
  server: ManagedMcpServer,
  signal: AbortSignal,
): Promise<McpTool[]> {
  const cached = toolCache.get(server.cacheKey);
  if (cached && cached.expiresAt > server.now()) return cached.tools;

  const headers = await server.headers();
  headers.set("accept", "application/json, text/event-stream");
  headers.set("content-type", "application/json");
  const send = (body: Record<string, unknown>) =>
    server.fetch(server.url, {
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      headers,
      method: "POST",
      signal,
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
  const initialized = await readRpcResponse(initialize, "responder-initialize", server.label);
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
      server.label,
    )).result);
    tools.push(...(listed.tools as McpTool[]));
    cursor = listed.nextCursor || undefined;
    if (!cursor) break;
  }

  const allowed = tools.filter(server.isAllowed);
  toolCache.set(server.cacheKey, {
    expiresAt: server.now() + TOOL_CACHE_TTL_MS,
    tools: allowed,
  });
  return allowed;
}

export type ManagedMcpDecision =
  | { kind: "forward" }
  | { kind: "list"; tools: McpTool[] }
  | { code: number; kind: "reject"; message: string; status: 400 | 404 };

/** Decides how the broker answers one MCP request for a managed server. */
export async function managedMcpDecision(input: {
  method: string;
  params: Record<string, unknown> | undefined;
  server: ManagedMcpServer;
  signal: AbortSignal;
}): Promise<ManagedMcpDecision> {
  if (input.method === "tools/list") {
    return { kind: "list", tools: await allowedManagedMcpTools(input.server, input.signal) };
  }
  if (input.method.startsWith("notifications/")) return { kind: "forward" };
  if (!forwardedMethods.has(input.method)) {
    return { code: -32601, kind: "reject", message: "Method not found", status: 404 };
  }
  if (input.method === "tools/call") {
    const name = z.string().safeParse(input.params?.name);
    const tools = await allowedManagedMcpTools(input.server, input.signal);
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
