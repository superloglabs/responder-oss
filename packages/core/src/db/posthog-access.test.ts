import { describe, expect, it, vi } from "vitest";
import { decryptCredentials, encryptCredentials } from "../credentials/encryption.js";
import { McpOAuthRefreshError, type StoredCustomMcpOAuthState } from "../integrations/custom-mcp.js";
import { POSTHOG_MCP_URL, type PostHogCredentials } from "../integrations/posthog.js";
import { type PostHogAccessDependencies, postHogAccessToken } from "./posthog-access.js";

process.env.CREDENTIAL_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

const issuedAt = Date.parse("2026-11-16T10:00:00Z");

function credentials(overrides: Partial<PostHogCredentials> = {}): PostHogCredentials {
  return {
    accessLevel: "read_only",
    authType: "oauth",
    mcpUrl: POSTHOG_MCP_URL,
    oauth: { tokens: { access_token: "old-token", expires_in: 3600, refresh_token: "refresh-1", token_type: "Bearer" } },
    tokenIssuedAt: issuedAt,
    ...overrides,
  };
}

// Runs the lease operation on the stored credentials and keeps what it saves.
function dependencies(stored: PostHogCredentials | null, overrides: Partial<PostHogAccessDependencies> = {}) {
  const saved: string[] = [];
  const deps: PostHogAccessDependencies = {
    now: () => issuedAt + 10 * 60_000,
    refresh: vi.fn(async (input: { oauth: StoredCustomMcpOAuthState }) => ({
      ...input.oauth,
      tokens: { access_token: "new-token", expires_in: 3600, refresh_token: "refresh-2", token_type: "Bearer" },
    })),
    withCredentialLease: (async (input: Parameters<PostHogAccessDependencies["withCredentialLease"]>[0]) => {
      if (!stored) return null;
      const result = await input.operation(encryptCredentials({ ...stored }), {});
      if (result.encryptedCredentials) saved.push(result.encryptedCredentials);
      return result.value;
    }) as PostHogAccessDependencies["withCredentialLease"],
    ...overrides,
  };
  return { deps, saved };
}

const target = { integrationAccountId: "account-1", organizationId: "org-1" };

describe("postHogAccessToken", () => {
  it("uses a token with time left", async () => {
    const { deps, saved } = dependencies(credentials());
    expect(await postHogAccessToken(target, deps)).toBe("old-token");
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it("refreshes a token about to expire, or one whose issue time is unknown, and stores it", async () => {
    const { deps, saved } = dependencies(credentials(), { now: () => issuedAt + 58 * 60_000 });
    expect(await postHogAccessToken(target, deps)).toBe("new-token");
    expect(saved).toHaveLength(1);
    expect(decryptCredentials<Record<string, unknown>>(saved[0]!)).toEqual(expect.objectContaining({
      tokenIssuedAt: issuedAt + 58 * 60_000,
    }));
    expect(deps.refresh).toHaveBeenCalledWith(expect.objectContaining({ mcpUrl: POSTHOG_MCP_URL }));

    const unknown = dependencies(credentials({ tokenIssuedAt: undefined }));
    expect(await postHogAccessToken(target, unknown.deps)).toBe("new-token");
  });

  it("returns null for a connection that is gone and passes on PostHog's refusal", async () => {
    expect(await postHogAccessToken(target, dependencies(null).deps)).toBeNull();
    const { deps } = dependencies(credentials(), {
      now: () => issuedAt + 2 * 3_600_000,
      refresh: vi.fn(async () => { throw new McpOAuthRefreshError(true); }),
    });
    await expect(postHogAccessToken(target, deps)).rejects.toBeInstanceOf(McpOAuthRefreshError);
  });
});
