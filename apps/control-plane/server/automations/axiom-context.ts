import { z } from "zod";
import { isAxiomReadOnlyTool } from "../../../../packages/core/src/integrations/axiom.js";
import { rpcMessages } from "./mcp-messages.js";

// Automation runs reach Axiom through the broker with the same read-only tool
// allowlist as investigations. Calls to other tools are refused, and tool
// listings are filtered before they reach the run.

export type AxiomContextDecision =
  | { kind: "forward" }
  | { code: number; kind: "reject"; message: string; status: 400 };

export function axiomContextDecision(input: {
  method: string;
  params?: Record<string, unknown>;
}): AxiomContextDecision {
  if (input.method !== "tools/call") return { kind: "forward" };
  const name = z.string().safeParse(input.params?.name);
  return name.success && isAxiomReadOnlyTool(name.data)
    ? { kind: "forward" }
    : {
        code: -32602,
        kind: "reject",
        message: "Unknown or non-read-only tool",
        status: 400,
      };
}

const toolListMessageSchema = z.object({
  result: z.object({
    tools: z.array(z.object({ name: z.string() }).passthrough()),
  }).passthrough(),
}).passthrough();

function parsedMessages(text: string, contentType: string): unknown[] | null {
  try {
    return rpcMessages(text, contentType);
  } catch {
    return null;
  }
}

const rpcErrorMessageSchema = z.object({ error: z.unknown() }).passthrough();

// Keeps only allowlisted tools in Axiom's answer to tools/list, as JSON. A
// failed request or a JSON-RPC error passes through. A successful answer that
// holds no readable listing is refused, so an unfiltered list never reaches
// the run.
export async function filterAxiomToolList(
  response: Response,
  requestId: string | number | undefined,
): Promise<Response> {
  const text = await response.text();
  const headers = new Headers(response.headers);
  const messages = parsedMessages(text, headers.get("content-type") ?? "");
  const listing = messages
    ?.map((message) => toolListMessageSchema.safeParse(message))
    .find((parsed) => parsed.success);
  if (!listing?.data) {
    const rpcFailure = messages?.some((message) => rpcErrorMessageSchema.safeParse(message).success);
    if (!response.ok || rpcFailure) {
      return new Response(text, { headers, status: response.status });
    }
    return Response.json(
      { error: { code: -32603, message: "Context provider request failed" }, id: requestId ?? null, jsonrpc: "2.0" },
      { headers: { "cache-control": "no-store" }, status: 502 },
    );
  }
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify({
    ...listing.data,
    result: {
      ...listing.data.result,
      tools: listing.data.result.tools.filter((tool) => isAxiomReadOnlyTool(tool.name)),
    },
  }), { headers, status: response.status });
}
