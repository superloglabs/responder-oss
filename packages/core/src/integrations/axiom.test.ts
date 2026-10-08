import { describe, expect, it } from "vitest";
import {
  AXIOM_MCP_URL,
  axiomWebhookSecret,
  parseAxiomCredentials,
} from "./axiom.js";

describe("Axiom credentials", () => {
  it("accepts an MCP OAuth session", () => {
    expect(
      parseAxiomCredentials({
        authType: "oauth",
        mcpUrl: AXIOM_MCP_URL,
        oauth: {
          tokens: {
            access_token: "access-token",
            refresh_token: "refresh-token",
            token_type: "bearer",
          },
        },
      }),
    ).toMatchObject({
      authType: "oauth",
      mcpUrl: AXIOM_MCP_URL,
      oauth: { tokens: { access_token: "access-token" } },
    });
  });

  it("rejects the legacy personal-token credential shape", () => {
    expect(() =>
      parseAxiomCredentials({
        mcpUrl: AXIOM_MCP_URL,
        organizationId: "axiom-example",
        personalAccessToken: "xapt-secret",
      }),
    ).toThrow();
  });
});

describe("axiomWebhookSecret", () => {
  const key = Buffer.alloc(32, 1).toString("base64");
  const accountId = "10000000-0000-4000-8000-000000000000";

  it("is stable for a connection and differs between connections and keys", () => {
    const secret = axiomWebhookSecret(accountId, key);

    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(axiomWebhookSecret(accountId, key)).toBe(secret);
    expect(axiomWebhookSecret("20000000-0000-4000-8000-000000000000", key)).not.toBe(secret);
    expect(axiomWebhookSecret(accountId, Buffer.alloc(32, 2).toString("base64"))).not.toBe(secret);
  });

  it("requires a 32-byte credential key", () => {
    expect(() => axiomWebhookSecret(accountId, "")).toThrow("CREDENTIAL_ENCRYPTION_KEY is required");
    expect(() => axiomWebhookSecret(accountId, Buffer.alloc(16, 1).toString("base64")))
      .toThrow("CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  });
});
