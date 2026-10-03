// OAuth for the management MCP server. MCP clients register themselves,
// send the person through Superlog sign-in and a workspace choice, and then
// call /api/mcp with an access token bound to that person and workspace.

export const mcpOAuthScope = "mcp";
export const mcpOAuthScopes = [mcpOAuthScope, "offline_access"];

// Prefixes tell OAuth tokens apart from API keys (`slk_`) and help secret
// scanners recognize them. They are not stored.
export const mcpAccessTokenPrefix = "slo_";
export const mcpRefreshTokenPrefix = "slr_";

// The sign-in, workspace choice, and consent steps share one page.
export const mcpOAuthPagePath = "/oauth/authorize";

export const mcpResourcePath = "/api/mcp";
export const authBasePath = "/api/auth";

export function mcpResourceUrl(baseUrl: string): string {
  return new URL(mcpResourcePath, baseUrl).toString();
}

export function mcpAuthorizationServerUrl(baseUrl: string): string {
  return new URL(authBasePath, baseUrl).toString();
}

export function mcpProtectedResourceMetadataUrl(baseUrl: string): string {
  return new URL(
    `/.well-known/oauth-protected-resource${mcpResourcePath}`,
    baseUrl,
  ).toString();
}

// RFC 9728 metadata. MCP clients read it to find the authorization server.
export function mcpProtectedResourceMetadata(baseUrl: string) {
  return {
    authorization_servers: [mcpAuthorizationServerUrl(baseUrl)],
    bearer_methods_supported: ["header"],
    resource: mcpResourceUrl(baseUrl),
    resource_documentation: "https://docs.superlog.sh/api-reference/mcp",
    resource_name: "Superlog",
    scopes_supported: mcpOAuthScopes,
  };
}

export function mcpWwwAuthenticate(baseUrl: string): string {
  return `Bearer realm="superlog", resource_metadata="${mcpProtectedResourceMetadataUrl(baseUrl)}", scope="${mcpOAuthScopes.join(" ")}"`;
}
