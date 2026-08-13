import { describe, expect, it } from "vitest";
import { sentryMcpHeaders } from "./sentry.js";

describe("Sentry MCP", () => {
  it("uses the explicit upstream-token authorization scheme", () => {
    expect(
      sentryMcpHeaders({
        accessToken: "sentry-test-token",
        mcpUrl: "https://mcp.sentry.dev/mcp/acme/api?skills=inspect",
        organizationSlug: "acme",
        projectSlug: "api",
      }),
    ).toEqual({ authorization: "Sentry-Bearer sentry-test-token" });
  });
});
