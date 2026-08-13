import { describe, expect, it } from "vitest";
import { datadogMcpHeaders } from "./datadog.js";

describe("Datadog investigation connection", () => {
  it("uses OAuth without exposing other credentials", () => {
    expect(
      datadogMcpHeaders({
        authType: "oauth",
        accessToken: "oauth-token",
        datacenter: "US1",
        mcpUrl: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
        site: "datadoghq.com",
      }),
    ).toEqual({ authorization: "Bearer oauth-token" });
  });

  it("uses both Datadog keys for key-based accounts", () => {
    expect(
      datadogMcpHeaders({
        authType: "api_keys",
        apiKey: "api-key",
        applicationKey: "application-key",
        datacenter: "US1",
        mcpUrl: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
        site: "datadoghq.com",
      }),
    ).toEqual({
      "dd-api-key": "api-key",
      "dd-application-key": "application-key",
    });
  });
});
