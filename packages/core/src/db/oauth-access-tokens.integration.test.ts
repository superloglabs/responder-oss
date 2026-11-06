import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  member,
  oauthAccessToken,
  oauthClient,
  organization,
  user,
} from "./auth-schema.js";
import { closeDatabase, getDatabase } from "./client.js";
import {
  authenticateOAuthAccessToken,
  hashOAuthAccessToken,
} from "./oauth-access-tokens.js";

// Run against a disposable, migrated PostgreSQL database only.
const testUrl = process.env.TEST_OAUTH_ACCESS_TOKENS_DATABASE_URL;
describe.skipIf(!testUrl)("OAuth access tokens (PostgreSQL)", () => {
  const options = { prefix: "slo_", scope: "mcp" };
  const clientId = `client-${randomUUID()}`;
  const organizationId = randomUUID();
  const userId = randomUUID();
  const tokens = {
    active: "a".repeat(20) + randomUUID().replaceAll("-", ""),
    revoked: "r".repeat(20) + randomUUID().replaceAll("-", ""),
  };

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", testUrl!);
    vi.stubEnv("DATABASE_POOL_SIZE", "2");
    const db = getDatabase();
    const createdAt = new Date();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await db.insert(organization).values({ createdAt, id: organizationId, name: "Acme", slug: organizationId });
    await db.insert(user).values({ email: `ash-${userId}@example.com`, emailVerified: true, id: userId, name: "Ash" });
    await db.insert(member).values({ createdAt, organizationId, role: "admin", userId });
    await db.insert(oauthClient).values({ clientId, name: "Claude Code", redirectUris: ["http://localhost/callback"] });
    await db.insert(oauthAccessToken).values([
      {
        clientId,
        createdAt,
        expiresAt,
        referenceId: organizationId,
        scopes: ["mcp"],
        token: hashOAuthAccessToken(tokens.active),
        userId,
      },
      {
        clientId,
        createdAt,
        expiresAt,
        referenceId: organizationId,
        revoked: createdAt,
        scopes: ["mcp"],
        token: hashOAuthAccessToken(tokens.revoked),
        userId,
      },
    ]);
  });
  afterAll(async () => {
    const db = getDatabase();
    await db.delete(oauthClient).where(eq(oauthClient.clientId, clientId));
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, userId));
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  it("accepts an unrevoked token for the workspace it was granted for", async () => {
    await expect(authenticateOAuthAccessToken(`slo_${tokens.active}`, options))
      .resolves.toMatchObject({ clientId, organizationId, user: { id: userId } });
  });

  // Better Auth 1.7 marks a session's access tokens revoked at sign-out
  // instead of deleting them.
  it("rejects a revoked token", async () => {
    await expect(authenticateOAuthAccessToken(`slo_${tokens.revoked}`, options))
      .resolves.toBeNull();
  });
});
