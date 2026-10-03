import { describe, expect, it } from "vitest";
import {
  mcpProtectedResourceMetadata,
  mcpProtectedResourceMetadataUrl,
  mcpWwwAuthenticate,
} from "./mcp-oauth.js";

describe("MCP OAuth metadata", () => {
  it("points MCP clients from the resource to the authorization server", () => {
    expect(mcpProtectedResourceMetadata("https://superlog.sh")).toEqual({
      authorization_servers: ["https://superlog.sh/api/auth"],
      bearer_methods_supported: ["header"],
      resource: "https://superlog.sh/api/mcp",
      resource_documentation: "https://docs.superlog.sh/api-reference/mcp",
      resource_name: "Superlog",
      scopes_supported: ["mcp", "offline_access"],
    });
  });

  it("names the resource metadata in the 401 challenge", () => {
    expect(mcpProtectedResourceMetadataUrl("https://superlog.sh")).toBe(
      "https://superlog.sh/.well-known/oauth-protected-resource/api/mcp",
    );
    expect(mcpWwwAuthenticate("https://superlog.sh")).toBe(
      'Bearer realm="superlog", resource_metadata="https://superlog.sh/.well-known/oauth-protected-resource/api/mcp", scope="mcp offline_access"',
    );
  });
});
