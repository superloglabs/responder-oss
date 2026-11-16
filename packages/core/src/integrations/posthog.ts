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
  /** When PostHog issued the current access token, in epoch milliseconds. */
  tokenIssuedAt?: number;
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
    tokenIssuedAt: z.number().int().nonnegative().optional(),
  }),
  z.object({
    accessLevel: z.literal("read_write"),
    authType: z.literal("oauth"),
    mcpUrl: z.literal(POSTHOG_READ_WRITE_MCP_URL),
    oauth: oauthSchema,
    tokenIssuedAt: z.number().int().nonnegative().optional(),
  }),
]);

export function parsePostHogCredentials(input: unknown): PostHogCredentials {
  return postHogCredentialsSchema.parse(input) as PostHogCredentials;
}

// An access token with less than five minutes left is refreshed before use.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Whether the stored access token can be used without a refresh. A token
 * whose issue time or lifetime is unknown is refreshed.
 */
export function postHogAccessTokenIsFresh(credentials: PostHogCredentials, now: number): boolean {
  const expiresIn = credentials.oauth.tokens?.expires_in;
  if (!credentials.oauth.tokens?.access_token || credentials.tokenIssuedAt === undefined) return false;
  if (typeof expiresIn !== "number") return false;
  return now < credentials.tokenIssuedAt + expiresIn * 1000 - TOKEN_REFRESH_MARGIN_MS;
}
