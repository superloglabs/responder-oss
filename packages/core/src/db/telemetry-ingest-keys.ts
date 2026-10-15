import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getDatabase } from "./client.js";
import { telemetryIngestKeys } from "./schema.js";

const tokenPrefix = "sl_ingest_";
const tokenPattern = /^sl_ingest_[A-Za-z0-9_-]{43}$/u;
// Characters of the key shown in lists: the prefix and six more.
const displayedPrefixLength = tokenPrefix.length + 6;
// Last-used times are recorded at most this often per key.
const lastUsedResolutionMs = 60_000;

export type TelemetryIngestKeySummary = {
  createdAt: string;
  id: string;
  lastUsedAt: string | null;
  name: string;
  prefix: string;
};

export function isTelemetryIngestToken(value: string): boolean {
  return tokenPattern.test(value);
}

export function hashTelemetryIngestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function summary(row: {
  createdAt: Date;
  id: string;
  lastUsedAt: Date | null;
  name: string;
  prefix: string;
}): TelemetryIngestKeySummary {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

// Creates a key for the workspace. Returns the key once; only its digest is
// stored.
export async function createTelemetryIngestKey(input: {
  createdBy: string;
  name: string;
  organizationId: string;
}): Promise<{ key: TelemetryIngestKeySummary; token: string }> {
  const token = `${tokenPrefix}${randomBytes(32).toString("base64url")}`;
  const [row] = await getDatabase()
    .insert(telemetryIngestKeys)
    .values({
      createdBy: input.createdBy,
      name: input.name,
      organizationId: input.organizationId,
      prefix: token.slice(0, displayedPrefixLength),
      tokenHash: hashTelemetryIngestToken(token),
    })
    .returning({
      createdAt: telemetryIngestKeys.createdAt,
      id: telemetryIngestKeys.id,
      lastUsedAt: telemetryIngestKeys.lastUsedAt,
      name: telemetryIngestKeys.name,
      prefix: telemetryIngestKeys.prefix,
    });
  return { key: summary(row!), token };
}

export async function listTelemetryIngestKeys(organizationId: string): Promise<TelemetryIngestKeySummary[]> {
  const rows = await getDatabase()
    .select({
      createdAt: telemetryIngestKeys.createdAt,
      id: telemetryIngestKeys.id,
      lastUsedAt: telemetryIngestKeys.lastUsedAt,
      name: telemetryIngestKeys.name,
      prefix: telemetryIngestKeys.prefix,
    })
    .from(telemetryIngestKeys)
    .where(and(eq(telemetryIngestKeys.organizationId, organizationId), isNull(telemetryIngestKeys.revokedAt)))
    .orderBy(desc(telemetryIngestKeys.createdAt), desc(telemetryIngestKeys.id));
  return rows.map(summary);
}

// Members revoke their own keys; owners and admins revoke any.
export async function revokeTelemetryIngestKey(input: {
  keyId: string;
  organizationId: string;
  role: string;
  userId: string;
}): Promise<"forbidden" | "not_found" | "revoked"> {
  const canRevokeAny = input.role.split(",").some((role) => role === "admin" || role === "owner");
  const active = and(
    eq(telemetryIngestKeys.organizationId, input.organizationId),
    eq(telemetryIngestKeys.id, input.keyId),
    isNull(telemetryIngestKeys.revokedAt),
  );
  const rows = await getDatabase()
    .update(telemetryIngestKeys)
    .set({ revokedAt: new Date() })
    .where(and(active, ...(canRevokeAny ? [] : [eq(telemetryIngestKeys.createdBy, input.userId)])))
    .returning({ id: telemetryIngestKeys.id });
  if (rows.length > 0) return "revoked";
  const exists = await getDatabase().select({ id: telemetryIngestKeys.id }).from(telemetryIngestKeys).where(active).limit(1);
  return exists.length > 0 ? "forbidden" : "not_found";
}

// The workspace an active key sends to.
export async function findTelemetryIngestKey(
  token: string,
): Promise<{ keyId: string; lastUsedAt: Date | null; organizationId: string } | null> {
  if (!isTelemetryIngestToken(token)) return null;
  const rows = await getDatabase()
    .select({
      keyId: telemetryIngestKeys.id,
      lastUsedAt: telemetryIngestKeys.lastUsedAt,
      organizationId: telemetryIngestKeys.organizationId,
    })
    .from(telemetryIngestKeys)
    .where(and(eq(telemetryIngestKeys.tokenHash, hashTelemetryIngestToken(token)), isNull(telemetryIngestKeys.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function recordTelemetryIngestKeyUse(keyId: string, now = new Date()): Promise<void> {
  await getDatabase()
    .update(telemetryIngestKeys)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(telemetryIngestKeys.id, keyId),
        or(
          isNull(telemetryIngestKeys.lastUsedAt),
          lt(telemetryIngestKeys.lastUsedAt, sql`${new Date(now.getTime() - lastUsedResolutionMs).toISOString()}::timestamptz`),
        ),
      ),
    );
}
