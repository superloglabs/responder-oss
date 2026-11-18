import { describe, expect, it } from "vitest";
import {
  parsePostHogCredentials,
  POSTHOG_MCP_URL,
  POSTHOG_READ_WRITE_MCP_URL,
  postHogMcpUrl,
  postHogOAuthScope,
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

  it("requests no write scope for read-only connections", () => {
    const scopes = postHogOAuthScope("read_only").split(" ");
    expect(scopes).toEqual(expect.arrayContaining([
      "user:read", "organization:read", "project:read", "logs:read", "query:read", "error_tracking:read",
    ]));
    expect(scopes.filter((scope) => !scope.endsWith(":read"))).toEqual([]);
  });

  it("requests write scopes only for the products read-write connections change", () => {
    const scopes = postHogOAuthScope("read_write").split(" ");
    expect(scopes).toEqual(expect.arrayContaining(postHogOAuthScope("read_only").split(" ")));
    expect(scopes).toEqual(expect.arrayContaining(["feature_flag:write", "annotation:write", "insight:write"]));
    expect(scopes).not.toEqual(expect.arrayContaining(["session_recording:write"]));
    expect(scopes).not.toEqual(expect.arrayContaining(["project:write"]));
    expect(scopes).not.toEqual(expect.arrayContaining(["organization:write"]));
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  it("requests only what Signal reads for Signal connections", () => {
    expect(postHogOAuthScope("signal").split(" ").sort()).toEqual([
      "dashboard:read",
      "error_tracking:read",
      "event_definition:read",
      "insight:read",
      "logs:read",
      "organization:read",
      "person:read",
      "project:read",
      "query:read",
      "session_recording:read",
      "tracing:read",
      "user:read",
    ]);
    expect(postHogOAuthScope("read_only").split(" "))
      .toEqual(expect.arrayContaining(postHogOAuthScope("signal").split(" ")));
  });
});
