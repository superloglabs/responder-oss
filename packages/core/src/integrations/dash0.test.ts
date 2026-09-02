import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDash0WebhookSecret,
  normalizeDash0McpUrl,
  parseDash0Credentials,
} from "./dash0.js";

describe("Dash0 integration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts a Dash0 HTTPS MCP endpoint and removes fragments", async () => {
    await expect(
      normalizeDash0McpUrl("https://mcp.eu-west-1.aws.dash0.com/mcp#setup"),
    ).resolves.toBe("https://mcp.eu-west-1.aws.dash0.com/mcp");
  });

  it("rejects a branded connection to another host", async () => {
    await expect(
      normalizeDash0McpUrl("https://mcp.example.com/mcp"),
    ).rejects.toThrow("copied from Dash0");
  });

  it("parses OAuth credentials without dropping the webhook secret", () => {
    const credentials = parseDash0Credentials({
      authType: "oauth",
      mcpUrl: "https://mcp.eu-west-1.aws.dash0.com/mcp",
      oauth: { tokens: { access_token: "access" } },
      webhookSecret: "a".repeat(32),
    });

    expect(credentials.webhookSecret).toHaveLength(32);
  });

  it("generates high-entropy webhook secrets", () => {
    expect(createDash0WebhookSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(createDash0WebhookSecret()).not.toBe(createDash0WebhookSecret());
  });
});
