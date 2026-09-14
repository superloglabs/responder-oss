import { z } from "zod";
import type { StoredCustomMcpOAuthState } from "./custom-mcp.js";

export const POSTHOG_MCP_URL = new URL(
  "https://mcp.posthog.com/mcp?mode=tools&readonly=true&features=alerts,dashboards,error_tracking,events,insights,logs,replay,replay_vision,sql,tracing,web_analytics",
).toString();

export interface PostHogCredentials {
  authType: "oauth";
  mcpUrl: string;
  oauth: StoredCustomMcpOAuthState;
}

const postHogCredentialsSchema = z.object({
  authType: z.literal("oauth"),
  mcpUrl: z.literal(POSTHOG_MCP_URL),
  oauth: z.object({
    clientInformation: z.record(z.string(), z.unknown()).optional(),
    codeVerifier: z.string().min(1).optional(),
    discoveryState: z.record(z.string(), z.unknown()).optional(),
    tokens: z.record(z.string(), z.unknown()).optional(),
  }),
});

export function parsePostHogCredentials(input: unknown): PostHogCredentials {
  return postHogCredentialsSchema.parse(input) as PostHogCredentials;
}
