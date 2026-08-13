import { safeCustomMcpFetch } from "@responder/core/integrations/custom-mcp";
import { describe, expect, it, vi } from "vitest";
import {
  clickStackMcpHeaders,
  createClickStackMcpServer,
} from "./clickstack.js";

const { serverConstructor } = vi.hoisted(() => ({
  serverConstructor: vi.fn(),
}));

vi.mock("@openai/agents", () => ({
  MCPServerStreamableHttp: class {
    constructor(options: unknown) {
      serverConstructor(options);
    }
  },
}));

describe("ClickStack MCP", () => {
  it("uses the configured Personal API Access Key as a bearer token", () => {
    expect(
      clickStackMcpHeaders({
        authType: "access_key",
        accessKey: "clickstack-access-key",
        mcpUrl: "https://clickstack.example/api/mcp",
      }),
    ).toEqual({ authorization: "Bearer clickstack-access-key" });
  });

  it("uses OAuth and the service id for ClickStack Cloud", () => {
    expect(
      clickStackMcpHeaders({
        authType: "oauth",
        accessToken: "cloud-access-token",
        mcpUrl: "https://mcp.clickhouse.cloud/clickstack",
        serviceId: "60000000-0000-4000-8000-000000000000",
      }),
    ).toEqual({
      authorization: "Bearer cloud-access-token",
      "x-service-id": "60000000-0000-4000-8000-000000000000",
    });
  });

  it("guards self-hosted MCP requests", () => {
    createClickStackMcpServer({
      authType: "access_key",
      accessKey: "clickstack-access-key",
      mcpUrl: "https://clickstack.example/api/mcp",
    });

    expect(serverConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ fetch: safeCustomMcpFetch }),
    );
  });
});
