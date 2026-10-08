import { z } from "zod";
import { rpcMessages } from "./mcp-messages.js";

// Cloud providers' managed MCP servers mark which tools only read. The broker
// lists tools itself, exposes only the ones a provider's rule allows, and
// refuses calls to any other tool or MCP method.

const TOOL_CACHE_TTL_MS = 10 * 60 * 1_000;
const MAX_CACHED_LISTINGS = 500;
const MAX_TOOL_PAGES = 10;
const PROTOCOL_VERSION = "2025-03-26";

// Methods forwarded to the provider. tools/list is answered by the broker
// itself, and other notifications are accepted and dropped.
const forwardedMethods = new Set([
  "initialize",
  "notifications/cancelled",
  "notifications/initialized",
  "ping",
  "tools/call",
]);

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

async function readRpcResponse(
  response: Response,
  id: string,
  label: string,
): Promise<z.infer<typeof rpcResponseSchema>> {
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  const messages = rpcMessages(
    await response.text(),
    response.headers.get("content-type") ?? "",
  );
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

// Holds each listing while it loads too, so concurrent requests share one.
// A shared listing does not follow any one request's abort signal; the
// provider fetch bounds it with its own timeout.
const toolCache = new Map<string, { expiresAt: number; tools: Promise<McpTool[]> }>();

function pruneToolCache(now: number) {
  for (const [key, entry] of toolCache) {
    if (entry.expiresAt <= now) toolCache.delete(key);
  }
  while (toolCache.size >= MAX_CACHED_LISTINGS) {
    toolCache.delete(toolCache.keys().next().value!);
  }
}

/** The tools a managed MCP server offers that its provider's rule allows. */
export function allowedManagedMcpTools(server: ManagedMcpServer): Promise<McpTool[]> {
  const now = server.now();
  const cached = toolCache.get(server.cacheKey);
  if (cached && cached.expiresAt > now) return cached.tools;

  pruneToolCache(now);
  const entry = {
    expiresAt: now + TOOL_CACHE_TTL_MS,
    tools: listAllowedTools(server),
  };
  toolCache.set(server.cacheKey, entry);
  entry.tools.catch(() => {
    if (toolCache.get(server.cacheKey) === entry) toolCache.delete(server.cacheKey);
  });
  return entry.tools;
}

async function listAllowedTools(server: ManagedMcpServer): Promise<McpTool[]> {
  const headers = await server.headers();
  headers.set("accept", "application/json, text/event-stream");
  headers.set("content-type", "application/json");
  const send = (body: Record<string, unknown>) =>
    server.fetch(server.url, {
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      headers,
      method: "POST",
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
  for (let page = 0; ; page += 1) {
    // A cut-off listing would hide tools, so it fails instead.
    if (page === MAX_TOOL_PAGES) {
      throw new Error(`${server.label} listed tools on more than ${MAX_TOOL_PAGES} pages`);
    }
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

  return tools.filter(server.isAllowed);
}

export type ManagedMcpDecision =
  | { kind: "accept" }
  | { kind: "forward" }
  | { kind: "list"; tools: McpTool[] }
  | { code: number; kind: "reject"; message: string; status: 400 | 404 };

/** Decides how the broker answers one MCP request for a managed server. */
export async function managedMcpDecision(input: {
  method: string;
  params: Record<string, unknown> | undefined;
  server: ManagedMcpServer;
}): Promise<ManagedMcpDecision> {
  if (input.method === "tools/list") {
    return { kind: "list", tools: await allowedManagedMcpTools(input.server) };
  }
  if (!forwardedMethods.has(input.method)) {
    if (input.method.startsWith("notifications/")) return { kind: "accept" };
    return { code: -32601, kind: "reject", message: "Method not found", status: 404 };
  }
  if (input.method === "tools/call") {
    const name = z.string().safeParse(input.params?.name);
    const tools = await allowedManagedMcpTools(input.server);
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
