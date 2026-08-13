export const CLICKSTACK_CLOUD_MCP_URL =
  "https://mcp.clickhouse.cloud/clickstack";
export const CLICKSTACK_CLOUD_OAUTH_ISSUER = "https://mcp.clickhouse.cloud";
export const CLICKSTACK_CLOUD_OAUTH_RESOURCE = CLICKSTACK_CLOUD_MCP_URL;

export function normalizeClickStackMcpUrl(value: string): string {
  const url = new URL(value.trim());
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    url.hostname,
  );
  const localHttpAllowed =
    process.env.NODE_ENV !== "production" &&
    url.protocol === "http:" &&
    isLoopback;
  if (url.protocol !== "https:" && !localHttpAllowed) {
    throw new Error("ClickStack MCP URLs must use HTTPS outside localhost");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "ClickStack MCP URLs cannot contain credentials, query parameters, or fragments",
    );
  }
  if (!/\/(?:api\/)?mcp\/?$/.test(url.pathname)) {
    throw new Error("Enter the full ClickStack MCP URL ending in /api/mcp");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString();
}

export function clickStackCloudMcpUrl(): string {
  return CLICKSTACK_CLOUD_MCP_URL;
}

export function logClickStackTokenRefreshFailure(status: number): void {
  console.error(
    JSON.stringify({
      event: "clickstack_token_refresh_failed",
      status,
    }),
  );
}

export function clickStackTeamUrl(mcpUrl: string): string {
  const url = new URL(normalizeClickStackMcpUrl(mcpUrl));
  url.pathname = url.pathname.endsWith("/api/mcp")
    ? url.pathname.replace(/\/api\/mcp$/, "/api/api/v2/team")
    : url.pathname.replace(/\/mcp$/, "/api/v2/team");
  return url.toString();
}
