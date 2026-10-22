import { describe, expect, it } from "vitest";
import {
  betterStackAuthorization,
  betterStackIncidentUrl,
  betterStackWebhookSecret,
  parseBetterStackCredentials,
} from "./betterstack.js";

describe("parseBetterStackCredentials", () => {
  it("always targets Better Stack's hosted MCP server", () => {
    expect(parseBetterStackCredentials({
      apiToken: "token",
      authType: "api_token",
      mcpUrl: "https://attacker.example",
    })).toEqual({
      apiToken: "token",
      authType: "api_token",
      mcpUrl: "https://mcp.betterstack.com",
    });
  });

  it("refuses credentials without a token", () => {
    expect(() => parseBetterStackCredentials({ apiToken: "", authType: "api_token" })).toThrow();
  });
});

describe("betterStackAuthorization", () => {
  it("sends the token as a bearer token", () => {
    expect(betterStackAuthorization({ apiToken: "token" })).toBe("Bearer token");
  });
});

describe("betterStackIncidentUrl", () => {
  it("links the incident in the team that owns it", () => {
    expect(betterStackIncidentUrl("123")).toBe("https://incidents.betterstack.com/team/0/incidents/123");
  });
});

describe("betterStackWebhookSecret", () => {
  const key = Buffer.alloc(32, 1).toString("base64");
  const accountId = "10000000-0000-4000-8000-000000000000";

  it("is stable for a connection and differs between connections and providers", async () => {
    const { honeycombWebhookSecret } = await import("./honeycomb.js");
    const secret = betterStackWebhookSecret(accountId, key);

    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(betterStackWebhookSecret(accountId, key)).toBe(secret);
    expect(betterStackWebhookSecret("20000000-0000-4000-8000-000000000000", key)).not.toBe(secret);
    expect(honeycombWebhookSecret(accountId, key)).not.toBe(secret);
  });
});
