import { z } from "zod";
import type { StoredCustomMcpOAuthState } from "./custom-mcp.js";

/** Cloudflare's hosted API MCP server. It reaches the whole Cloudflare API. */
export const CLOUDFLARE_MCP_URL = "https://mcp.cloudflare.com/mcp";

// Requesting only the identity and refresh scopes makes Cloudflare's consent
// screen preselect its read-only scope template. The person can still pick
// other scopes there, so the granted scopes are checked after every token
// exchange and refresh.
export const CLOUDFLARE_OAUTH_SCOPE = "user:read account:read offline_access";

// The actions Cloudflare's own read-only template grants, for example
// `zone.read`, `d1.metadata_read`, `teams-connector-cloudflared.monitoring`,
// and `teams.report`.
const readOnlyScope = /^[a-z0-9_-]+[:.](?:metadata_read|monitoring|read|report)$/u;

export function isCloudflareReadOnlyScope(scope: string): boolean {
  return scope === "offline_access" || readOnlyScope.test(scope);
}

export class CloudflareWriteScopeError extends Error {
  constructor(readonly scopes: string[]) {
    super(
      scopes.length > 0
        ? `Cloudflare granted scopes that can change resources: ${scopes.join(", ")}`
        : "Cloudflare did not report the granted scopes",
    );
    this.name = "CloudflareWriteScopeError";
  }
}

/**
 * The API tool can call any Cloudflare endpoint, so the granted OAuth scopes
 * are what keeps the connection read-only. Throws unless every granted scope
 * only reads.
 */
export function assertCloudflareReadOnlyGrant(
  tokens: StoredCustomMcpOAuthState["tokens"],
): void {
  const scopes = typeof tokens?.scope === "string"
    ? tokens.scope.split(/\s+/u).filter(Boolean)
    : [];
  if (scopes.length === 0) throw new CloudflareWriteScopeError([]);
  const writeScopes = scopes.filter((scope) => !isCloudflareReadOnlyScope(scope));
  if (writeScopes.length > 0) throw new CloudflareWriteScopeError(writeScopes);
}

// `search` reads Cloudflare's OpenAPI spec, `execute` calls the API, `docs`
// searches the developer docs, and `whoami` names the connected user. The
// server does not annotate `search`, `execute`, or `docs` as read-only; the
// read-only scope grant limits what `execute` can do.
export const cloudflareContextToolNames = ["docs", "execute", "search", "whoami"] as const;

export function isCloudflareContextTool(tool: unknown): boolean {
  const name = (tool as { name?: unknown } | null)?.name;
  return (
    typeof name === "string" &&
    (cloudflareContextToolNames as readonly string[]).includes(name)
  );
}

export interface CloudflareAccount {
  id: string;
  name: string;
}

export const cloudflareAccountsSchema = z
  .array(z.object({ id: z.string().min(1), name: z.string() }))
  .max(200);

export interface CloudflareCredentials {
  authType: "oauth";
  mcpUrl: string;
  oauth: StoredCustomMcpOAuthState;
}

const cloudflareCredentialsSchema = z.object({
  authType: z.literal("oauth"),
  mcpUrl: z.literal(CLOUDFLARE_MCP_URL),
  oauth: z.object({
    clientInformation: z.record(z.string(), z.unknown()).optional(),
    codeVerifier: z.string().min(1).optional(),
    discoveryState: z.record(z.string(), z.unknown()).optional(),
    tokens: z.record(z.string(), z.unknown()).optional(),
  }),
});

export function parseCloudflareCredentials(input: unknown): CloudflareCredentials {
  return cloudflareCredentialsSchema.parse(input) as CloudflareCredentials;
}

/**
 * The connected accounts as the agent reads them. Account names come from
 * Cloudflare and are quoted so a name cannot add instructions.
 */
export function cloudflareAccountList(accounts: readonly CloudflareAccount[]): string {
  return accounts
    .map((account) => `${JSON.stringify(account.name)} (account_id ${account.id})`)
    .join(", ");
}
