import { describe, expect, it } from "vitest";
import {
  parseSignozCredentials,
  parseSignozInstanceUrl,
  signozWebhookSecret,
} from "./signoz.js";

describe("parseSignozInstanceUrl", () => {
  it.each([
    "https://acme.us.signoz.cloud",
    "https://acme.us.signoz.cloud/",
    "https://ACME.us.signoz.cloud/home?tab=logs",
    "acme.us.signoz.cloud",
    "  acme.us.signoz.cloud/  ",
  ])("reads %s as the US instance", (input) => {
    expect(parseSignozInstanceUrl(input)).toEqual({
      instanceUrl: "https://acme.us.signoz.cloud",
      mcpUrl: "https://mcp.us.signoz.cloud/mcp",
      region: "us",
    });
  });

  it("derives the MCP server for each region", () => {
    expect(parseSignozInstanceUrl("tough-gecko.eu2.signoz.cloud")?.mcpUrl).toBe("https://mcp.eu2.signoz.cloud/mcp");
    expect(parseSignozInstanceUrl("demo.in.signoz.cloud")?.mcpUrl).toBe("https://mcp.in.signoz.cloud/mcp");
  });

  it.each([
    "",
    "http://acme.us.signoz.cloud",
    "https://acme.us.signoz.cloud:8443",
    "https://user:pass@acme.us.signoz.cloud",
    "https://signoz.example.com",
    "https://us.signoz.cloud",
    "https://a.b.us.signoz.cloud",
    "https://acme.us.signoz.cloud.evil.example",
    "https://mcp.us.signoz.cloud",
    "https://ingest.us.signoz.cloud",
    "not a url",
  ])("rejects %s", (input) => {
    expect(parseSignozInstanceUrl(input)).toBeNull();
  });
});

describe("parseSignozCredentials", () => {
  it("derives the MCP server from the stored instance", () => {
    expect(parseSignozCredentials({
      apiKey: "signoz-key",
      authType: "api_key",
      instanceUrl: "https://acme.eu.signoz.cloud",
    })).toEqual({
      apiKey: "signoz-key",
      authType: "api_key",
      instanceUrl: "https://acme.eu.signoz.cloud",
      mcpUrl: "https://mcp.eu.signoz.cloud/mcp",
      region: "eu",
    });
  });

  it("refuses a stored instance outside SigNoz Cloud", () => {
    expect(() => parseSignozCredentials({
      apiKey: "signoz-key",
      authType: "api_key",
      instanceUrl: "https://attacker.example",
    })).toThrow("not a SigNoz Cloud instance");
  });
});

describe("signozWebhookSecret", () => {
  const key = Buffer.alloc(32, 1).toString("base64");
  const accountId = "10000000-0000-4000-8000-000000000000";

  it("is stable for a connection and differs between connections and providers", async () => {
    const { axiomWebhookSecret } = await import("./axiom.js");
    const secret = signozWebhookSecret(accountId, key);

    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(signozWebhookSecret(accountId, key)).toBe(secret);
    expect(signozWebhookSecret("20000000-0000-4000-8000-000000000000", key)).not.toBe(secret);
    expect(axiomWebhookSecret(accountId, key)).not.toBe(secret);
  });
});
