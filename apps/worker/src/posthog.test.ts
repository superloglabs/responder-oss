import { describe, expect, it, vi } from "vitest";
import { createPostHogMcpServer, postHogReadOnlyToolFilter } from "./posthog.js";

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

describe("PostHog MCP", () => {
  it("allows only tools annotated read-only", async () => {
    await expect(
      postHogReadOnlyToolFilter(null, {
        name: "error-tracking-issue-retrieve",
        annotations: { readOnlyHint: true },
      }),
    ).resolves.toBe(true);
    await expect(
      postHogReadOnlyToolFilter(null, {
        name: "feature-flag-create",
        annotations: { readOnlyHint: false },
      }),
    ).resolves.toBe(false);
  });

  it("uses the OAuth token without exposing webhook credentials", () => {
    createPostHogMcpServer({
      accessToken: "oauth-access-token",
      accountId: "account-1",
      displayName: "PostHog",
      mcpUrl: "https://mcp.posthog.com/mcp?readonly=true&mode=tools",
    });

    expect(serverConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        requestInit: {
          headers: { authorization: "Bearer oauth-access-token" },
        },
        toolFilter: postHogReadOnlyToolFilter,
      }),
    );
  });
});
