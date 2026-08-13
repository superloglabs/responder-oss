import { describe, expect, it } from "vitest";
import { customMcpHeaders } from "./custom-mcp.js";

describe("custom MCP investigation connection", () => {
  it("sends only the selected account's bearer token", () => {
    expect(
      customMcpHeaders({
        accessToken: "secret-token",
        accountId: "account-1",
        displayName: "Production metrics",
        mcpUrl: "https://mcp.example.com/mcp",
      }),
    ).toEqual({ authorization: "Bearer secret-token" });
  });
});
