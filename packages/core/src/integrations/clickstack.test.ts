import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLICKSTACK_CLOUD_MCP_URL,
  clickStackTeamUrl,
  logClickStackTokenRefreshFailure,
  normalizeClickStackMcpUrl,
} from "./clickstack.js";

describe("ClickStack endpoints", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the managed ClickStack Cloud endpoint", () => {
    expect(CLICKSTACK_CLOUD_MCP_URL).toBe(
      "https://mcp.clickhouse.cloud/clickstack",
    );
  });

  it("accepts self-hosted HTTPS MCP URLs", () => {
    expect(
      normalizeClickStackMcpUrl(
        "https://clickstack.example.com/api/mcp/",
      ),
    ).toBe("https://clickstack.example.com/api/mcp");
    expect(
      normalizeClickStackMcpUrl("https://clickstack.example/mcp"),
    ).toBe("https://clickstack.example/mcp");
    expect(
      normalizeClickStackMcpUrl("http://127.0.0.1:58080/api/mcp"),
    ).toBe("http://127.0.0.1:58080/api/mcp");
  });

  it("derives the authenticated team endpoint", () => {
    expect(
      clickStackTeamUrl("https://clickstack.example/api/mcp"),
    ).toBe("https://clickstack.example/api/api/v2/team");
    expect(
      clickStackTeamUrl("https://clickstack-api.example/mcp"),
    ).toBe("https://clickstack-api.example/api/v2/team");
  });

  it("rejects insecure or incomplete endpoints", () => {
    expect(() =>
      normalizeClickStackMcpUrl("http://clickstack.example/api/mcp"),
    ).toThrow("must use HTTPS outside localhost");
    expect(() =>
      normalizeClickStackMcpUrl("https://clickstack.example"),
    ).toThrow("ending in /api/mcp");
    expect(() =>
      normalizeClickStackMcpUrl(
        "https://clickstack.example/api/mcp?access_key=secret",
      ),
    ).toThrow("query parameters");
  });

  it("rejects loopback HTTP endpoints in production", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(() =>
      normalizeClickStackMcpUrl("http://127.0.0.1:58080/api/mcp"),
    ).toThrow("must use HTTPS outside localhost");
  });

  it("logs ClickStack Cloud token refresh failures", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    logClickStackTokenRefreshFailure(401);

    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({
        event: "clickstack_token_refresh_failed",
        status: 401,
      }),
    );
  });
});
