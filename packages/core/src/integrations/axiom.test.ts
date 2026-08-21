import { describe, expect, it } from "vitest";
import {
  AXIOM_MCP_URL,
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
