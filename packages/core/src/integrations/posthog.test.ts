import { describe, expect, it } from "vitest";
import {
  parsePostHogCredentials,
  POSTHOG_MCP_URL,
  POSTHOG_READ_WRITE_MCP_URL,
  postHogMcpUrl,
} from "./posthog.js";

const oauth = { tokens: { access_token: "access-token" } };

describe("PostHog credentials", () => {
  it("reads connections made before the access choice as read-only", () => {
    expect(parsePostHogCredentials({ authType: "oauth", mcpUrl: POSTHOG_MCP_URL, oauth }))
      .toEqual({ accessLevel: "read_only", authType: "oauth", mcpUrl: POSTHOG_MCP_URL, oauth });
  });

  it("accepts a read-write connection on the read-write MCP URL", () => {
    expect(parsePostHogCredentials({
      accessLevel: "read_write",
      authType: "oauth",
      mcpUrl: POSTHOG_READ_WRITE_MCP_URL,
      oauth,
    }).accessLevel).toBe("read_write");
  });

  it("rejects an access level that does not match the MCP URL", () => {
    expect(() => parsePostHogCredentials({
      accessLevel: "read_write",
      authType: "oauth",
      mcpUrl: POSTHOG_MCP_URL,
      oauth,
    })).toThrow();
    expect(() => parsePostHogCredentials({
      authType: "oauth",
      mcpUrl: POSTHOG_READ_WRITE_MCP_URL,
      oauth,
    })).toThrow();
  });

  it("keeps PostHog's read-only mode off only for read-write connections", () => {
    expect(new URL(postHogMcpUrl("read_only")).searchParams.get("readonly")).toBe("true");
    expect(new URL(postHogMcpUrl("read_write")).searchParams.has("readonly")).toBe(false);
  });
});
