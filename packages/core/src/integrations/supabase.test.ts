import { describe, expect, it } from "vitest";
import {
  parseSupabaseCredentials,
  hasRequiredSupabaseTools,
  supabaseAllowedTools,
  supabaseDisplayName,
  supabaseExternalAccountId,
  supabaseMcpUrl,
} from "./supabase.js";

const projectRef = "abcdefghijklmnopqrst";

describe("Supabase integration", () => {
  it("builds a project-scoped logs-only URL", () => {
    expect(supabaseMcpUrl({ accessMode: "logs", projectRef })).toBe(
      "https://mcp.supabase.com/mcp?project_ref=abcdefghijklmnopqrst&features=debugging&read_only=true",
    );
    expect(supabaseAllowedTools("logs")).toEqual(["get_logs", "query_logs"]);
  });

  it("builds a project-scoped read-only database URL", () => {
    expect(supabaseMcpUrl({ accessMode: "read_only", projectRef })).toBe(
      "https://mcp.supabase.com/mcp?project_ref=abcdefghijklmnopqrst&features=debugging%2Cdatabase&read_only=true",
    );
    expect(supabaseAllowedTools("read_only")).toEqual([
      "get_logs",
      "query_logs",
      "execute_sql",
      "list_extensions",
      "list_tables",
    ]);
  });

  it("accepts either deployed log tool name but requires the database set", () => {
    expect(hasRequiredSupabaseTools({
      accessMode: "logs",
      tools: ["get_logs"],
    })).toBe(true);
    expect(hasRequiredSupabaseTools({
      accessMode: "logs",
      tools: ["query_logs"],
    })).toBe(true);
    expect(hasRequiredSupabaseTools({
      accessMode: "read_only",
      tools: ["get_logs", "execute_sql", "list_extensions"],
    })).toBe(false);
    expect(hasRequiredSupabaseTools({
      accessMode: "read_only",
      tools: ["get_logs", "execute_sql", "list_extensions", "list_tables"],
    })).toBe(true);
  });

  it("omits read-only mode only for full SQL access", () => {
    expect(supabaseMcpUrl({ accessMode: "read_write", projectRef })).toBe(
      "https://mcp.supabase.com/mcp?project_ref=abcdefghijklmnopqrst&features=debugging%2Cdatabase",
    );
  });

  it("rejects credentials whose stored URL does not match their scope", () => {
    expect(() =>
      parseSupabaseCredentials({
        accessMode: "logs",
        authType: "oauth",
        mcpUrl: "https://mcp.supabase.com/mcp?project_ref=anotherprojectref1234",
        oauth: {},
        projectRef,
      }),
    ).toThrow("stored Supabase MCP scope is invalid");
  });

  it("uses the project and permission level as the connection identity", () => {
    expect(supabaseExternalAccountId({ accessMode: "logs", projectRef })).toBe(
      "abcdefghijklmnopqrst:logs",
    );
    expect(supabaseDisplayName({ accessMode: "read_write", projectRef })).toBe(
      "abcdefghijklmnopqrst · Full database SQL access",
    );
  });
});
