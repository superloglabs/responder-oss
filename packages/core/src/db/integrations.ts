import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, gt, inArray, isNotNull, lte } from "drizzle-orm";
import { getDatabase } from "./client.js";
import {
  integrationAccounts,
  integrationConnectionStates,
  integrationProvider,
  integrationResourceKind,
  integrationResources,
  repositories,
} from "./schema.js";

export type IntegrationProvider = (typeof integrationProvider.enumValues)[number];
export type IntegrationResourceKind = (typeof integrationResourceKind.enumValues)[number];

const CONNECTION_STATE_TTL_MS = 10 * 60 * 1_000;

function hashConnectionState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export async function createIntegrationConnectionState(input: {
  organizationId: string;
  userId: string;
  provider: IntegrationProvider;
  codeVerifier?: string;
  metadata?: Record<string, unknown>;
  returnTo?: string;
  routingUrl?: string;
}): Promise<string> {
  const nonce = randomBytes(32).toString("base64url");
  const state = input.routingUrl
    ? `responder-v1.${Buffer.from(input.routingUrl).toString("base64url")}.${nonce}`
    : nonce;

  const database = getDatabase();
  const expiresAt = new Date(Date.now() + CONNECTION_STATE_TTL_MS);

  // Bound abandoned OAuth attempts. The unique owner/provider index keeps one
  // live flow even when the same user starts requests concurrently, while the
  // indexed prune prevents expired rows from accumulating across tenants.
  await database
    .delete(integrationConnectionStates)
    .where(lte(integrationConnectionStates.expiresAt, new Date()));
  await database
    .insert(integrationConnectionStates)
    .values({
      stateHash: hashConnectionState(state),
      organizationId: input.organizationId,
      userId: input.userId,
      provider: input.provider,
      codeVerifier: input.codeVerifier,
      metadata: input.metadata ?? {},
      returnTo: input.returnTo ?? "/settings",
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [
        integrationConnectionStates.organizationId,
        integrationConnectionStates.userId,
        integrationConnectionStates.provider,
      ],
      set: {
        stateHash: hashConnectionState(state),
        codeVerifier: input.codeVerifier ?? null,
        metadata: input.metadata ?? {},
        returnTo: input.returnTo ?? "/settings",
        expiresAt,
        createdAt: new Date(),
      },
    });

  return state;
}

export async function consumeIntegrationConnectionState(
  provider: IntegrationProvider,
  state: string,
  tenant: { organizationId: string; userId: string },
): Promise<{
  organizationId: string;
  userId: string;
  codeVerifier: string | null;
  metadata: Record<string, unknown>;
  returnTo: string;
} | null> {
  const rows = await getDatabase()
    .delete(integrationConnectionStates)
    .where(
      and(
        eq(integrationConnectionStates.stateHash, hashConnectionState(state)),
        eq(integrationConnectionStates.provider, provider),
        eq(integrationConnectionStates.organizationId, tenant.organizationId),
        eq(integrationConnectionStates.userId, tenant.userId),
        gt(integrationConnectionStates.expiresAt, new Date()),
      ),
    )
    .returning({
      organizationId: integrationConnectionStates.organizationId,
      userId: integrationConnectionStates.userId,
      codeVerifier: integrationConnectionStates.codeVerifier,
      metadata: integrationConnectionStates.metadata,
      returnTo: integrationConnectionStates.returnTo,
    });

  return rows[0] ?? null;
}

export async function upsertIntegrationAccount(input: {
  organizationId: string;
  provider: IntegrationProvider;
  externalAccountId: string;
  displayName: string;
  encryptedCredentials?: string | null;
  credentialKeyVersion?: number | null;
  metadata?: Record<string, unknown>;
  status?: "connected" | "error" | "pending";
}): Promise<string> {
  const db = getDatabase();
  const inserted = await db
    .insert(integrationAccounts)
    .values({
      organizationId: input.organizationId,
      provider: input.provider,
      externalAccountId: input.externalAccountId,
      displayName: input.displayName,
      status: input.status ?? "connected",
      encryptedCredentials: input.encryptedCredentials,
      credentialKeyVersion: input.credentialKeyVersion,
      metadata: input.metadata ?? {},
    })
    .onConflictDoNothing()
    .returning({ id: integrationAccounts.id });

  if (inserted[0]) return inserted[0].id;

  const existing = await db
    .select({
      id: integrationAccounts.id,
    })
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.organizationId, input.organizationId),
        eq(integrationAccounts.provider, input.provider),
        eq(integrationAccounts.externalAccountId, input.externalAccountId),
      ),
    )
    .limit(1);

  if (!existing[0]) {
    throw new Error("Unable to resolve integration account conflict");
  }

  await db
    .update(integrationAccounts)
    .set({
      displayName: input.displayName,
      status: input.status ?? "connected",
      encryptedCredentials: input.encryptedCredentials,
      credentialKeyVersion: input.credentialKeyVersion,
      metadata: input.metadata ?? {},
      updatedAt: new Date(),
    })
    .where(eq(integrationAccounts.id, existing[0].id));

  return existing[0].id;
}

export async function setIntegrationAccountStatus(
  integrationAccountId: string,
  status: "connected" | "error" | "pending",
): Promise<void> {
  await getDatabase()
    .update(integrationAccounts)
    .set({ status, updatedAt: new Date() })
    .where(eq(integrationAccounts.id, integrationAccountId));
}

export async function getOrganizationIntegrationAccount(input: {
  integrationAccountId: string;
  organizationId: string;
  provider: IntegrationProvider;
}) {
  const rows = await getDatabase()
    .select({
      id: integrationAccounts.id,
      encryptedCredentials: integrationAccounts.encryptedCredentials,
      metadata: integrationAccounts.metadata,
      status: integrationAccounts.status,
    })
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.id, input.integrationAccountId),
        eq(integrationAccounts.organizationId, input.organizationId),
        eq(integrationAccounts.provider, input.provider),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function getOrganizationIntegrationAccountByExternalId(input: {
  externalAccountId: string;
  organizationId: string;
  provider: IntegrationProvider;
}) {
  const rows = await getDatabase()
    .select({
      id: integrationAccounts.id,
      encryptedCredentials: integrationAccounts.encryptedCredentials,
      metadata: integrationAccounts.metadata,
      status: integrationAccounts.status,
    })
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.externalAccountId, input.externalAccountId),
        eq(integrationAccounts.organizationId, input.organizationId),
        eq(integrationAccounts.provider, input.provider),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function updateIntegrationAccountCredentials(input: {
  encryptedCredentials: string;
  integrationAccountId: string;
  organizationId: string;
  provider: IntegrationProvider;
  status?: "connected" | "error" | "pending";
}): Promise<boolean> {
  const updated = await getDatabase()
    .update(integrationAccounts)
    .set({
      encryptedCredentials: input.encryptedCredentials,
      ...(input.status ? { status: input.status } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(integrationAccounts.id, input.integrationAccountId),
        eq(integrationAccounts.organizationId, input.organizationId),
        eq(integrationAccounts.provider, input.provider),
      ),
    )
    .returning({ id: integrationAccounts.id });

  return updated.length > 0;
}

export async function getRecoverableSentryIntegrationAccount(
  organizationId: string,
) {
  const rows = await getDatabase()
    .select({
      id: integrationAccounts.id,
      encryptedCredentials: integrationAccounts.encryptedCredentials,
      externalAccountId: integrationAccounts.externalAccountId,
      metadata: integrationAccounts.metadata,
    })
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.organizationId, organizationId),
        eq(integrationAccounts.provider, "sentry"),
        inArray(integrationAccounts.status, ["pending", "error"]),
        isNotNull(integrationAccounts.encryptedCredentials),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function listConnectedSentryIntegrationAccounts(
  organizationId: string,
) {
  return getDatabase()
    .select({
      id: integrationAccounts.id,
      encryptedCredentials: integrationAccounts.encryptedCredentials,
      metadata: integrationAccounts.metadata,
    })
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.organizationId, organizationId),
        eq(integrationAccounts.provider, "sentry"),
        eq(integrationAccounts.status, "connected"),
        isNotNull(integrationAccounts.encryptedCredentials),
      ),
    );
}

export async function listConnectedIntegrationAccountCredentials(
  organizationId: string,
  provider: IntegrationProvider,
) {
  return getDatabase()
    .select({
      id: integrationAccounts.id,
      encryptedCredentials: integrationAccounts.encryptedCredentials,
    })
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.organizationId, organizationId),
        eq(integrationAccounts.provider, provider),
        eq(integrationAccounts.status, "connected"),
        isNotNull(integrationAccounts.encryptedCredentials),
      ),
    );
}

export interface SyncedIntegrationResource {
  externalId: string;
  displayName: string;
  metadata?: Record<string, unknown>;
}

export async function getSlackChannelConnection(input: {
  organizationId: string;
  integrationAccountId: string;
  channelId: string;
}) {
  const rows = await getDatabase()
    .select({
      encryptedCredentials: integrationAccounts.encryptedCredentials,
      metadata: integrationResources.metadata,
    })
    .from(integrationResources)
    .innerJoin(
      integrationAccounts,
      eq(integrationAccounts.id, integrationResources.integrationAccountId),
    )
    .where(
      and(
        eq(integrationAccounts.id, input.integrationAccountId),
        eq(integrationAccounts.organizationId, input.organizationId),
        eq(integrationAccounts.provider, "slack"),
        eq(integrationAccounts.status, "connected"),
        eq(integrationResources.kind, "slack_channel"),
        eq(integrationResources.externalId, input.channelId),
        eq(integrationResources.available, true),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function markSlackChannelJoined(input: {
  integrationAccountId: string;
  channelId: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  await getDatabase()
    .update(integrationResources)
    .set({
      metadata: { ...input.metadata, isMember: true },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(integrationResources.integrationAccountId, input.integrationAccountId),
        eq(integrationResources.kind, "slack_channel"),
        eq(integrationResources.externalId, input.channelId),
      ),
    );
}

export async function replaceIntegrationResources(
  integrationAccountId: string,
  kind: IntegrationResourceKind,
  resources: SyncedIntegrationResource[],
): Promise<void> {
  const db = getDatabase();

  await db.transaction(async (tx) => {
    await tx
      .update(integrationResources)
      .set({ available: false, updatedAt: new Date() })
      .where(
        and(
          eq(integrationResources.integrationAccountId, integrationAccountId),
          eq(integrationResources.kind, kind),
        ),
      );

    for (const resource of resources) {
      await tx
        .insert(integrationResources)
        .values({
          integrationAccountId,
          kind,
          externalId: resource.externalId,
          displayName: resource.displayName,
          metadata: resource.metadata ?? {},
        })
        .onConflictDoUpdate({
          target: [
            integrationResources.integrationAccountId,
            integrationResources.kind,
            integrationResources.externalId,
          ],
          set: {
            displayName: resource.displayName,
            available: true,
            metadata: resource.metadata ?? {},
            updatedAt: new Date(),
          },
        });
    }
  });
}

export interface SyncedRepository {
  externalId: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  metadata?: Record<string, unknown>;
}

export async function replaceRepositories(
  integrationAccountId: string,
  syncedRepositories: SyncedRepository[],
): Promise<void> {
  const db = getDatabase();

  await db.transaction(async (tx) => {
    await tx
      .update(repositories)
      .set({ available: false, updatedAt: new Date() })
      .where(eq(repositories.integrationAccountId, integrationAccountId));

    for (const repository of syncedRepositories) {
      await tx
        .insert(repositories)
        .values({
          integrationAccountId,
          externalId: repository.externalId,
          fullName: repository.fullName,
          defaultBranch: repository.defaultBranch,
          private: repository.private,
          metadata: repository.metadata ?? {},
        })
        .onConflictDoUpdate({
          target: [
            repositories.integrationAccountId,
            repositories.externalId,
          ],
          set: {
            fullName: repository.fullName,
            defaultBranch: repository.defaultBranch,
            private: repository.private,
            available: true,
            metadata: repository.metadata ?? {},
            updatedAt: new Date(),
          },
        });
    }
  });
}

export async function listOrganizationIntegrationAccounts(organizationId: string) {
  const db = getDatabase();
  const accounts = await db
    .select({
      id: integrationAccounts.id,
      provider: integrationAccounts.provider,
      externalAccountId: integrationAccounts.externalAccountId,
      displayName: integrationAccounts.displayName,
      status: integrationAccounts.status,
      metadata: integrationAccounts.metadata,
      updatedAt: integrationAccounts.updatedAt,
    })
    .from(integrationAccounts)
    .where(eq(integrationAccounts.organizationId, organizationId));

  const resourceCounts = await db
    .select({
      integrationAccountId: integrationResources.integrationAccountId,
      count: count(),
    })
    .from(integrationResources)
    .where(eq(integrationResources.available, true))
    .groupBy(integrationResources.integrationAccountId);
  const repositoryCounts = await db
    .select({
      integrationAccountId: repositories.integrationAccountId,
      count: count(),
    })
    .from(repositories)
    .where(eq(repositories.available, true))
    .groupBy(repositories.integrationAccountId);

  const resourcesByAccount = new Map(
    resourceCounts.map((row) => [row.integrationAccountId, row.count]),
  );
  const repositoriesByAccount = new Map(
    repositoryCounts.map((row) => [row.integrationAccountId, row.count]),
  );

  return accounts.map((account) => ({
    ...account,
    resourceCount:
      (resourcesByAccount.get(account.id) ?? 0) +
      (repositoriesByAccount.get(account.id) ?? 0),
  }));
}
