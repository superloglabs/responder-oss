import { describe, expect, it, vi } from "vitest";
import { encryptCredentials } from "../credentials/encryption.js";
import { McpOAuthRefreshError, type StoredCustomMcpOAuthState } from "../integrations/custom-mcp.js";
import { RailwayScopeError, type RailwayCredentials } from "../integrations/railway.js";
import { type RailwayAccessDependencies, railwayAccessToken } from "./railway-access.js";

process.env.CREDENTIAL_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

const issuedAt = Date.parse("2026-11-13T10:00:00Z");

function credentials(scope = "openid email profile offline_access workspace:viewer"): RailwayCredentials {
  return {
    accessLevel: "read_only",
    authType: "oauth",
    oauth: { tokens: { access_token: "old-token", expires_in: 3600, refresh_token: "refresh-1", scope, token_type: "Bearer" } },
    tokenIssuedAt: issuedAt,
  };
}

// Runs the lease operation on the stored credentials and keeps what it saves.
function dependencies(stored: RailwayCredentials | null, overrides: Partial<RailwayAccessDependencies> = {}) {
  const saved: string[] = [];
  const deps: RailwayAccessDependencies = {
    now: () => issuedAt + 10 * 60_000,
    refresh: vi.fn(async (input: { oauth: StoredCustomMcpOAuthState }) => ({
      ...input.oauth,
      tokens: { access_token: "new-token", expires_in: 3600, refresh_token: "refresh-2", token_type: "Bearer" },
    })),
    withCredentialLease: (async (input: Parameters<RailwayAccessDependencies["withCredentialLease"]>[0]) => {
      if (!stored) return null;
      const result = await input.operation(encryptCredentials({ ...stored }), {});
      if (result.encryptedCredentials) saved.push(result.encryptedCredentials);
      return result.value;
    }) as RailwayAccessDependencies["withCredentialLease"],
    ...overrides,
  };
  return { deps, saved };
}

const target = { integrationAccountId: "account-1", organizationId: "org-1" };

describe("railwayAccessToken", () => {
  it("uses a token with time left", async () => {
    const { deps, saved } = dependencies(credentials());
    expect(await railwayAccessToken(target, deps)).toBe("old-token");
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it("refreshes a token about to expire, keeps the granted scope, and stores it", async () => {
    const { deps, saved } = dependencies(credentials(), { now: () => issuedAt + 58 * 60_000 });
    expect(await railwayAccessToken(target, deps)).toBe("new-token");
    expect(saved).toHaveLength(1);
    // Railway's token endpoint rejects any resource indicator.
    expect(deps.refresh).toHaveBeenCalledWith(expect.objectContaining({
      mcpUrl: "https://backboard.railway.com",
      resourceIndicator: false,
    }));
  });

  it("returns null for a connection that is gone and refuses a write grant", async () => {
    expect(await railwayAccessToken(target, dependencies(null).deps)).toBeNull();
    const writable = dependencies(credentials("openid workspace:admin"));
    await expect(railwayAccessToken(target, writable.deps)).rejects.toBeInstanceOf(RailwayScopeError);
  });

  it("does not store a refreshed grant with more access than chosen", async () => {
    const { deps, saved } = dependencies(credentials(), {
      now: () => issuedAt + 58 * 60_000,
      refresh: vi.fn(async () => ({
        tokens: { access_token: "new-token", expires_in: 3600, scope: "openid workspace:admin", token_type: "Bearer" },
      })),
    });
    await expect(railwayAccessToken(target, deps)).rejects.toBeInstanceOf(RailwayScopeError);
    expect(saved).toHaveLength(0);
  });

  it("passes on Railway's refusal", async () => {
    const { deps } = dependencies(credentials(), {
      now: () => issuedAt + 2 * 3_600_000,
      refresh: vi.fn(async () => { throw new McpOAuthRefreshError(true); }),
    });
    await expect(railwayAccessToken(target, deps)).rejects.toBeInstanceOf(McpOAuthRefreshError);
  });
});
