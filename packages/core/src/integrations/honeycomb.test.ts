import { describe, expect, it } from "vitest";
import {
  honeycombAuthorization,
  honeycombWebhookSecret,
  parseHoneycombCredentials,
} from "./honeycomb.js";

describe("parseHoneycombCredentials", () => {
  it("derives the MCP server from the stored region", () => {
    expect(parseHoneycombCredentials({
      authType: "api_key",
      keyId: "hcxmk_01",
      keySecret: "secret",
      region: "eu",
    })).toEqual({
      authType: "api_key",
      keyId: "hcxmk_01",
      keySecret: "secret",
      mcpUrl: "https://mcp.eu1.honeycomb.io/mcp",
      region: "eu",
    });
  });

  it("refuses a stored region Honeycomb does not have", () => {
    expect(() => parseHoneycombCredentials({
      authType: "api_key",
      keyId: "hcxmk_01",
      keySecret: "secret",
      region: "attacker.example",
    })).toThrow();
  });
});

describe("honeycombAuthorization", () => {
  it("joins the key ID and secret", () => {
    expect(honeycombAuthorization({ keyId: "hcxmk_01", keySecret: "secret" })).toBe("Bearer hcxmk_01:secret");
  });
});

describe("honeycombWebhookSecret", () => {
  const key = Buffer.alloc(32, 1).toString("base64");
  const accountId = "10000000-0000-4000-8000-000000000000";

  it("is stable for a connection and differs between connections and providers", async () => {
    const { signozWebhookSecret } = await import("./signoz.js");
    const secret = honeycombWebhookSecret(accountId, key);

    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(honeycombWebhookSecret(accountId, key)).toBe(secret);
    expect(honeycombWebhookSecret("20000000-0000-4000-8000-000000000000", key)).not.toBe(secret);
    expect(signozWebhookSecret(accountId, key)).not.toBe(secret);
  });
});
