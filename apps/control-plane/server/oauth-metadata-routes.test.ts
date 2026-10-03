import { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";

const baseUrl = "https://superlog.example";

describe("OAuth discovery for the MCP server", () => {
  let app: Hono;

  beforeAll(async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-with-enough-entropy-0123456789abcdef");
    vi.stubEnv("BETTER_AUTH_URL", baseUrl);
    vi.stubEnv("DATABASE_URL", "postgres://user:password@127.0.0.1:1/unused");
    const { oauthMetadataRoutes } = await import("./oauth-metadata-routes.js");
    app = new Hono().route("/.well-known", oauthMetadataRoutes);
  });

  it("describes the MCP resource at both RFC 9728 locations", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource/api/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const response = await app.request(path);

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.json()).toMatchObject({
        authorization_servers: [`${baseUrl}/api/auth`],
        resource: `${baseUrl}/api/mcp`,
        scopes_supported: ["mcp", "offline_access"],
      });
    }
  });

  it("describes an authorization server that registers public clients with PKCE", async () => {
    for (const path of [
      "/.well-known/oauth-authorization-server/api/auth",
      "/.well-known/oauth-authorization-server",
    ]) {
      const response = await app.request(path);
      const metadata = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(metadata).toMatchObject({
        authorization_endpoint: `${baseUrl}/api/auth/oauth2/authorize`,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        issuer: `${baseUrl}/api/auth`,
        registration_endpoint: `${baseUrl}/api/auth/oauth2/register`,
        response_types_supported: ["code"],
        scopes_supported: ["mcp", "offline_access"],
        token_endpoint: `${baseUrl}/api/auth/oauth2/token`,
      });
      expect(metadata.token_endpoint_auth_methods_supported).toContain("none");
      expect(metadata.jwks_uri).toBeUndefined();
    }
  });

  it("does not serve other well-known paths", async () => {
    const response = await app.request("/.well-known/openid-configuration");

    expect(response.status).toBe(404);
  });
});
