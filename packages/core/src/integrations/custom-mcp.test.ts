import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CustomMcpOAuthProvider,
  parseCustomMcpCredentials,
  validateCustomMcpUrl,
} from "./custom-mcp.js";

describe("custom MCP security", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    "http://169.254.169.254/latest/meta-data",
    "https://127.0.0.1/mcp",
    "https://10.0.0.4/mcp",
    "https://[::1]/mcp",
  ])("rejects private endpoint %s", async (url) => {
    await expect(validateCustomMcpUrl(url)).rejects.toThrow(/public|HTTPS/);
  });

  it("allows local HTTP endpoints only when explicitly enabled", async () => {
    await expect(
      validateCustomMcpUrl("http://localhost:8787/mcp", { allowLocal: true }),
    ).resolves.toMatchObject({ hostname: "localhost", protocol: "http:" });
    await expect(
      validateCustomMcpUrl("http://localhost:8787/mcp"),
    ).rejects.toThrow("HTTPS");
    await expect(
      validateCustomMcpUrl("http://127.0.0.1:8787/mcp", { allowLocal: true }),
    ).resolves.toMatchObject({ hostname: "127.0.0.1", protocol: "http:" });
    await expect(
      validateCustomMcpUrl("http://[::1]:8787/mcp", { allowLocal: true }),
    ).resolves.toMatchObject({ hostname: "[::1]", protocol: "http:" });
  });

  it("keeps OAuth client state, verifier, and tokens together", () => {
    const provider = new CustomMcpOAuthProvider({
      connectionState: "state",
      redirectUrl: "https://responder.example/api/integrations/custom_mcp/callback",
    });
    provider.saveClientInformation({ client_id: "client-1" });
    provider.saveCodeVerifier("verifier");
    provider.saveTokens({ access_token: "access", token_type: "bearer" });

    expect(provider.state()).toBe("state");
    expect(provider.codeVerifier()).toBe("verifier");
    expect(provider.clientMetadata).toMatchObject({
      client_name: "Responder",
      client_uri: "https://responder.example/",
      logo_uri:
        "https://responder.example/superlog-pictogram-dark.svg",
    });
    expect(provider.snapshot()).toMatchObject({
      clientInformation: { client_id: "client-1" },
      tokens: { access_token: "access" },
    });
  });

  it("validates encrypted credential payload shapes", () => {
    expect(
      parseCustomMcpCredentials({
        apiToken: "token",
        authType: "api_token",
        mcpUrl: "https://mcp.example.com/mcp",
      }),
    ).toMatchObject({ authType: "api_token" });
    expect(() =>
      parseCustomMcpCredentials({
        authType: "api_token",
        mcpUrl: "https://mcp.example.com/mcp",
      }),
    ).toThrow();
  });
});
