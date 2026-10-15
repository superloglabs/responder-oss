import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getDatabase } from "./client.js";
import { integrationAccounts, integrationResources, telemetryIngestKeys, telemetrySources } from "./schema.js";

export type TelemetrySourceProvider = "aws" | "gcp" | "vercel";
export type TelemetrySourceStatus = "active" | "failed" | "pending";

export type TelemetrySourceSummary = {
  createdAt: string;
  displayName: string;
  externalId: string;
  id: string;
  integrationAccountId: string | null;
  lastError: string | null;
  // The latest delivery: the source's ingest key use, or the worker's last
  // successful read.
  lastReceivedAt: string | null;
  provider: TelemetrySourceProvider;
  state: Record<string, unknown>;
  status: TelemetrySourceStatus;
};

const summaryColumns = {
  createdAt: telemetrySources.createdAt,
  displayName: telemetrySources.displayName,
  externalId: telemetrySources.externalId,
  id: telemetrySources.id,
  ingestKeyId: telemetrySources.ingestKeyId,
  integrationAccountId: telemetrySources.integrationAccountId,
  keyLastUsedAt: telemetryIngestKeys.lastUsedAt,
  lastError: telemetrySources.lastError,
  lastReceivedAt: telemetrySources.lastReceivedAt,
  provider: telemetrySources.provider,
  state: telemetrySources.state,
  status: telemetrySources.status,
};

function latest(...dates: Array<Date | null>): Date | null {
  return dates.reduce<Date | null>((found, date) => (date && (!found || date > found) ? date : found), null);
}

function summary(row: {
  createdAt: Date;
  displayName: string;
  externalId: string;
  id: string;
  ingestKeyId: string | null;
  integrationAccountId: string | null;
  keyLastUsedAt: Date | null;
  lastError: string | null;
  lastReceivedAt: Date | null;
  provider: TelemetrySourceProvider;
  state: Record<string, unknown>;
  status: TelemetrySourceStatus;
}): TelemetrySourceSummary {
  return {
    createdAt: row.createdAt.toISOString(),
    displayName: row.displayName,
    externalId: row.externalId,
    id: row.id,
    integrationAccountId: row.integrationAccountId,
    lastError: row.lastError,
    lastReceivedAt: latest(row.lastReceivedAt, row.keyLastUsedAt)?.toISOString() ?? null,
    provider: row.provider,
    state: row.state,
    status: row.status,
  };
}

function selectSummaries() {
  return getDatabase()
    .select(summaryColumns)
    .from(telemetrySources)
    .leftJoin(telemetryIngestKeys, eq(telemetryIngestKeys.id, telemetrySources.ingestKeyId));
}

export async function listTelemetrySources(organizationId: string): Promise<TelemetrySourceSummary[]> {
  const rows = await selectSummaries()
    .where(eq(telemetrySources.organizationId, organizationId))
    .orderBy(asc(telemetrySources.provider), desc(telemetrySources.createdAt));
  return rows.map(summary);
}

export async function getTelemetrySource(input: {
  id: string;
  organizationId: string;
}): Promise<(TelemetrySourceSummary & { createdBy: string | null; ingestKeyId: string | null }) | null> {
  const rows = await getDatabase()
    .select({ ...summaryColumns, createdBy: telemetrySources.createdBy })
    .from(telemetrySources)
    .leftJoin(telemetryIngestKeys, eq(telemetryIngestKeys.id, telemetrySources.ingestKeyId))
    .where(and(eq(telemetrySources.id, input.id), eq(telemetrySources.organizationId, input.organizationId)))
    .limit(1);
  const row = rows[0];
  return row ? { ...summary(row), createdBy: row.createdBy, ingestKeyId: row.ingestKeyId } : null;
}

// Adds a source, or replaces the one with the same provider and external ID.
// Returns the previous ingest key so the caller can revoke it.
export async function saveTelemetrySource(input: {
  createdBy: string;
  displayName: string;
  externalId: string;
  ingestKeyId?: string | null;
  integrationAccountId?: string | null;
  organizationId: string;
  provider: TelemetrySourceProvider;
  state?: Record<string, unknown>;
  status: TelemetrySourceStatus;
}): Promise<{ id: string; previousIngestKeyId: string | null; previousState: Record<string, unknown> | null }> {
  return getDatabase().transaction(async (transaction) => {
    const [previous] = await transaction
      .select({ ingestKeyId: telemetrySources.ingestKeyId, state: telemetrySources.state })
      .from(telemetrySources)
      .where(
        and(
          eq(telemetrySources.organizationId, input.organizationId),
          eq(telemetrySources.provider, input.provider),
          eq(telemetrySources.externalId, input.externalId),
        ),
      )
      .for("update");
    const values = {
      displayName: input.displayName,
      ingestKeyId: input.ingestKeyId ?? null,
      integrationAccountId: input.integrationAccountId ?? null,
      lastError: null,
      state: input.state ?? {},
      status: input.status,
      updatedAt: new Date(),
    };
    const [row] = await transaction
      .insert(telemetrySources)
      .values({
        ...values,
        createdBy: input.createdBy,
        externalId: input.externalId,
        organizationId: input.organizationId,
        provider: input.provider,
      })
      .onConflictDoUpdate({
        set: values,
        target: [telemetrySources.organizationId, telemetrySources.provider, telemetrySources.externalId],
      })
      .returning({ id: telemetrySources.id });
    return {
      id: row!.id,
      previousIngestKeyId: previous?.ingestKeyId && previous.ingestKeyId !== input.ingestKeyId ? previous.ingestKeyId : null,
      previousState: previous?.state ?? null,
    };
  });
}

export async function updateTelemetrySource(
  id: string,
  update: {
    lastError?: string | null;
    lastReceivedAt?: Date;
    state?: Record<string, unknown>;
    status?: TelemetrySourceStatus;
  },
): Promise<void> {
  await getDatabase()
    .update(telemetrySources)
    .set({ ...update, updatedAt: new Date() })
    .where(eq(telemetrySources.id, id));
}

export async function deleteTelemetrySource(input: { id: string; organizationId: string }): Promise<void> {
  await getDatabase()
    .delete(telemetrySources)
    .where(and(eq(telemetrySources.id, input.id), eq(telemetrySources.organizationId, input.organizationId)));
}

// Revokes a key a source made, without the member checks that apply to keys
// people create.
export async function revokeTelemetrySourceIngestKey(keyId: string): Promise<void> {
  await getDatabase()
    .update(telemetryIngestKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(telemetryIngestKeys.id, keyId), isNull(telemetryIngestKeys.revokedAt)));
}

// Connected accounts a source can use, by provider.
export async function listTelemetrySourceAccounts(organizationId: string): Promise<
  Array<{ displayName: string; id: string; provider: "gcp" | "vercel" }>
> {
  const rows = await getDatabase()
    .select({
      displayName: integrationAccounts.displayName,
      id: integrationAccounts.id,
      provider: integrationAccounts.provider,
    })
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.organizationId, organizationId),
        inArray(integrationAccounts.provider, ["gcp", "vercel"]),
        eq(integrationAccounts.status, "connected"),
        isNotNull(integrationAccounts.encryptedCredentials),
      ),
    )
    .orderBy(asc(integrationAccounts.displayName));
  return rows as Array<{ displayName: string; id: string; provider: "gcp" | "vercel" }>;
}

// Google Cloud sources the worker reads, with their connection's credentials.
// Failed sources are read again, so a passing error does not stop them.
export async function listGcpTelemetrySources(): Promise<
  Array<{
    encryptedCredentials: string;
    id: string;
    organizationId: string;
    state: Record<string, unknown>;
  }>
> {
  const rows = await getDatabase()
    .select({
      encryptedCredentials: integrationAccounts.encryptedCredentials,
      id: telemetrySources.id,
      organizationId: telemetrySources.organizationId,
      state: telemetrySources.state,
    })
    .from(telemetrySources)
    .innerJoin(integrationAccounts, eq(integrationAccounts.id, telemetrySources.integrationAccountId))
    .where(
      and(
        eq(telemetrySources.provider, "gcp"),
        eq(integrationAccounts.status, "connected"),
        isNotNull(integrationAccounts.encryptedCredentials),
      ),
    );
  return rows.flatMap((row) => (row.encryptedCredentials ? [{ ...row, encryptedCredentials: row.encryptedCredentials }] : []));
}

// The Vercel projects an installation shares, as synced when it connected.
export async function listVercelInstallationProjectIds(integrationAccountId: string): Promise<string[]> {
  const rows = await getDatabase()
    .select({ externalId: integrationResources.externalId })
    .from(integrationResources)
    .where(
      and(
        eq(integrationResources.integrationAccountId, integrationAccountId),
        eq(integrationResources.kind, "vercel_project"),
        eq(integrationResources.available, true),
      ),
    );
  return rows.map((row) => row.externalId);
}
