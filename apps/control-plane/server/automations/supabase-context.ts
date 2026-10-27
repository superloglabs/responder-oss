import {
  supabaseAllowedTools,
  type SupabaseAccessMode,
} from "../../../../packages/core/src/integrations/supabase.js";
import type { ManagedMcpServer } from "./managed-mcp-context.js";

// Automation runs reach the project-scoped hosted Supabase MCP server through
// the broker with the same reviewed tools as investigations. The URL's
// features and read_only parameters bound the server; the allowlist also
// blocks migrations, Edge Function deploys, branching, and administration.

/** Supabase's hosted MCP server as the broker reaches it for a connection. */
export function supabaseContextServer(input: {
  accessMode: SupabaseAccessMode;
  accessToken: () => Promise<string>;
  accountId: string;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  mcpUrl: string;
  now: () => number;
}): ManagedMcpServer {
  const allowedTools = new Set(supabaseAllowedTools(input.accessMode));
  return {
    cacheKey: `supabase:${input.accountId}:${input.accessMode}`,
    fetch: input.fetch,
    headers: async () => new Headers({
      authorization: `Bearer ${await input.accessToken()}`,
    }),
    isAllowed: (tool) => allowedTools.has(tool.name),
    label: "Supabase MCP",
    now: input.now,
    url: input.mcpUrl,
  };
}
