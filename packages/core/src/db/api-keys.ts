import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { member, user } from "./auth-schema.js";
import { getDatabase } from "./client.js";
import { apiKeys } from "./schema.js";

const apiKeyTokenPrefix = "slk_";
const apiKeyTokenPattern = /^slk_[A-Za-z0-9_-]{43}$/u;
// Characters of the key shown in lists: the prefix and eight more.
const displayedPrefixLength = apiKeyTokenPrefix.length + 8;
// Last-used times are recorded at most this often per key.
const lastUsedResolutionMs = 60_000;

export interface ApiKeySummary {
  createdAt: Date;
  createdBy: { email: string; id: string; name: string };
  id: string;
  lastUsedAt: Date | null;
  name: string;
  prefix: string;
}

export interface ApiKeyPrincipal {
  apiKeyId: string;
  organizationId: string;
  role: string;
  user: { email: string; id: string; name: string };
}

export function generateApiKeyToken(): string {
  return `${apiKeyTokenPrefix}${randomBytes(32).toString("base64url")}`;
}

export function isApiKeyToken(value: string): boolean {
  return apiKeyTokenPattern.test(value);
}

export function hashApiKeyToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function apiKeyDisplayPrefix(token: string): string {
  return token.slice(0, displayedPrefixLength);
}

// Returns the key once. Only its digest is stored.
export async function createApiKey(input: {
  name: string;
  organizationId: string;
  user: { email: string; id: string; name: string };
}): Promise<{ key: ApiKeySummary; token: string }> {
  const token = generateApiKeyToken();
  const rows = await getDatabase()
    .insert(apiKeys)
    .values({
      createdBy: input.user.id,
      name: input.name,
      organizationId: input.organizationId,
      prefix: apiKeyDisplayPrefix(token),
      tokenHash: hashApiKeyToken(token),
    })
    .returning({
      createdAt: apiKeys.createdAt,
      id: apiKeys.id,
      lastUsedAt: apiKeys.lastUsedAt,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
    });
  const row = rows[0];
  if (!row) throw new Error("Unable to create API key");
  return { key: { ...row, createdBy: input.user }, token };
}

export async function listApiKeys(
  organizationId: string,
): Promise<ApiKeySummary[]> {
  const rows = await getDatabase()
    .select({
      createdAt: apiKeys.createdAt,
      creatorEmail: user.email,
      creatorId: user.id,
      creatorName: user.name,
      id: apiKeys.id,
      lastUsedAt: apiKeys.lastUsedAt,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
    })
    .from(apiKeys)
    .innerJoin(user, eq(user.id, apiKeys.createdBy))
    .where(
      and(eq(apiKeys.organizationId, organizationId), isNull(apiKeys.revokedAt)),
    )
    .orderBy(desc(apiKeys.createdAt));
  return rows.map(({ creatorEmail, creatorId, creatorName, ...row }) => ({
    ...row,
    createdBy: { email: creatorEmail, id: creatorId, name: creatorName },
  }));
}

// Admins and owners can revoke any key in the workspace; other members only
// their own.
export async function revokeApiKey(input: {
  apiKeyId: string;
  organizationId: string;
  role: string;
  userId: string;
}): Promise<boolean> {
  const canRevokeAny = input.role
    .split(",")
    .some((role) => role === "admin" || role === "owner");
  const rows = await getDatabase()
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, input.apiKeyId),
        eq(apiKeys.organizationId, input.organizationId),
        isNull(apiKeys.revokedAt),
        ...(canRevokeAny ? [] : [eq(apiKeys.createdBy, input.userId)]),
      ),
    )
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}

// Resolves an active key whose creator is still a member of its workspace.
export async function authenticateApiKey(
  token: string,
  now = new Date(),
): Promise<ApiKeyPrincipal | null> {
  if (!isApiKeyToken(token)) return null;
  const db = getDatabase();
  const rows = await db
    .select({
      apiKeyId: apiKeys.id,
      email: user.email,
      lastUsedAt: apiKeys.lastUsedAt,
      name: user.name,
      organizationId: apiKeys.organizationId,
      role: member.role,
      userId: user.id,
    })
    .from(apiKeys)
    .innerJoin(user, eq(user.id, apiKeys.createdBy))
    .innerJoin(
      member,
      and(
        eq(member.organizationId, apiKeys.organizationId),
        eq(member.userId, apiKeys.createdBy),
      ),
    )
    .where(
      and(
        eq(apiKeys.tokenHash, hashApiKeyToken(token)),
        isNull(apiKeys.revokedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (
    !row.lastUsedAt ||
    now.getTime() - row.lastUsedAt.getTime() >= lastUsedResolutionMs
  ) {
    await db
      .update(apiKeys)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(apiKeys.id, row.apiKeyId),
          or(
            isNull(apiKeys.lastUsedAt),
            lt(
              apiKeys.lastUsedAt,
              new Date(now.getTime() - lastUsedResolutionMs),
            ),
          ),
        ),
      );
  }
  return {
    apiKeyId: row.apiKeyId,
    organizationId: row.organizationId,
    role: row.role,
    user: { email: row.email, id: row.userId, name: row.name },
  };
}
