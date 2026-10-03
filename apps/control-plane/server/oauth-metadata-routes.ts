import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { getAuth } from "./auth.js";
import { controlPlaneBaseUrl } from "./integrations/urls.js";
import { authBasePath, mcpProtectedResourceMetadata, mcpResourcePath } from "./mcp-oauth.js";

const metadataCacheControl = "public, max-age=300";

// OAuth discovery documents for MCP clients, mounted at /.well-known. The
// path-suffixed forms come from RFC 9728 and RFC 8414; the bare forms serve
// clients that look only at the origin. Other well-known paths are not found
// rather than falling through to the app shell.
export const oauthMetadataRoutes = new Hono()
  .use("*", cors({ allowMethods: ["GET", "HEAD", "OPTIONS"], origin: "*" }))
  .get("/oauth-protected-resource", protectedResourceMetadata)
  .get(`/oauth-protected-resource${mcpResourcePath}`, protectedResourceMetadata)
  .get("/oauth-authorization-server", authorizationServerMetadata)
  .get(`/oauth-authorization-server${authBasePath}`, authorizationServerMetadata)
  .all("*", (context) => context.json({ error: "Not found" }, 404));

function protectedResourceMetadata(context: Context) {
  context.header("Cache-Control", metadataCacheControl);
  return context.json(mcpProtectedResourceMetadata(controlPlaneBaseUrl()));
}

function authorizationServerMetadata(context: Context) {
  return oauthProviderAuthServerMetadata(getAuth(), {
    headers: { "Cache-Control": metadataCacheControl },
  })(context.req.raw);
}
