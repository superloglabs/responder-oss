import { z } from "zod";
import { isAxiomReadOnlyTool } from "../../../../packages/core/src/integrations/axiom.js";

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

// Streamable HTTP servers answer with JSON or with a server-sent event stream
// that carries the JSON-RPC messages.
function rpcMessages(text: string, contentType: string): unknown[] {
  if (!contentType.includes("text/event-stream")) return [JSON.parse(text)];
  return text.split(/\r?\n\r?\n/u).flatMap((event) => {
    const data = event
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    return data ? [JSON.parse(data) as unknown] : [];
  });
}

function parsedMessages(text: string, contentType: string): unknown[] {
  try {
    return rpcMessages(text, contentType);
  } catch {
    return [];
  }
}

// Keeps only allowlisted tools in Axiom's answer to tools/list, as JSON. An
// answer without a tool listing, such as an error, passes through unchanged.
export async function filterAxiomToolList(response: Response): Promise<Response> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const headers = new Headers(response.headers);
  const listing = parsedMessages(text, contentType)
    .map((message) => toolListMessageSchema.safeParse(message))
    .find((parsed) => parsed.success);
  if (!listing?.data) return new Response(text, { headers, status: response.status });
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify({
    ...listing.data,
    result: {
      ...listing.data.result,
      tools: listing.data.result.tools.filter((tool) => isAxiomReadOnlyTool(tool.name)),
    },
  }), { headers, status: response.status });
}
