import { z } from "zod";
import type { StoredCustomMcpOAuthState } from "./custom-mcp.js";

const readFeatures = "alerts,dashboards,error_tracking,events,insights,logs,replay,replay_vision,sql,tracing,web_analytics";

export const POSTHOG_MCP_URL = new URL(
  `https://mcp.posthog.com/mcp?mode=tools&readonly=true&features=${readFeatures}`,
).toString();

// Read-write connections also reach the products automations are likely to
// change, such as feature flags and annotations.
export const POSTHOG_READ_WRITE_MCP_URL = new URL(
  `https://mcp.posthog.com/mcp?mode=tools&features=${readFeatures},annotations,cohorts,experiments,flags,notebooks,surveys`,
).toString();

export const postHogAccessLevels = ["read_only", "read_write"] as const;
export const postHogAccessLevelSchema = z.enum(postHogAccessLevels);
export type PostHogAccessLevel = z.infer<typeof postHogAccessLevelSchema>;

/** The MCP URL a connection at this access level uses for automations. */
export function postHogMcpUrl(accessLevel: PostHogAccessLevel): string {
  return accessLevel === "read_write" ? POSTHOG_READ_WRITE_MCP_URL : POSTHOG_MCP_URL;
}

export interface PostHogCredentials {
  accessLevel: PostHogAccessLevel;
  authType: "oauth";
  mcpUrl: string;
  oauth: StoredCustomMcpOAuthState;
}

const oauthSchema = z.object({
  clientInformation: z.record(z.string(), z.unknown()).optional(),
  codeVerifier: z.string().min(1).optional(),
  discoveryState: z.record(z.string(), z.unknown()).optional(),
  tokens: z.record(z.string(), z.unknown()).optional(),
});

// Connections made before the access choice have no access level and read
// only.
const postHogCredentialsSchema = z.union([
  z.object({
    accessLevel: z.literal("read_only").default("read_only"),
    authType: z.literal("oauth"),
    mcpUrl: z.literal(POSTHOG_MCP_URL),
    oauth: oauthSchema,
  }),
  z.object({
    accessLevel: z.literal("read_write"),
    authType: z.literal("oauth"),
    mcpUrl: z.literal(POSTHOG_READ_WRITE_MCP_URL),
    oauth: oauthSchema,
  }),
]);

export function parsePostHogCredentials(input: unknown): PostHogCredentials {
  return postHogCredentialsSchema.parse(input) as PostHogCredentials;
}
