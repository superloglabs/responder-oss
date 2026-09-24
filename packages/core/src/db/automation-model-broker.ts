import { automationModelProviderSchema } from "../automations/config.js";
import type { randomBytes as nodeRandomBytes } from "node:crypto";
import { and, eq, gt, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import {
  issueAutomationModelBrokerToken,
} from "../automations/model-broker.js";
import type { AutomationModelProvider } from "../automations/config.js";
import {
  decryptCredentials,
  encryptCredentials,
} from "../credentials/encryption.js";
import { getDatabase } from "./client.js";
import {
  automationModelBrokerGrants,
  automationRuns,
  automationVersionIntegrationAccounts,
  integrationAccounts,
  integrationResources,
} from "./schema.js";

const maximumGrantLifetimeMs = 60 * 60_000;
const maximumGrantRequests = 128;
const maximumOutputTokensPerRequest = 100_000;
const modelIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/u;
const runIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u;
const tokenHashPattern = /^[a-f0-9]{64}$/u;

interface AutomationModelCredentials extends Record<string, unknown> {
  contextOnly?: boolean;
  apiKey: string;
}

interface CreateGrantDependencies {
  now?: () => Date;
  randomBytes?: typeof nodeRandomBytes;
}

interface ClaimGrantDependencies {
  decryptCredentials?: (
    encryptedCredentials: string,
  ) => AutomationModelCredentials;
  now?: () => Date;
}

export interface CreateAutomationModelBrokerGrantInput {
  contextOnly?: boolean;
  apiKey: string;
  expiresAt: Date;
  maxOutputTokensPerRequest: number;
  maxRequests: number;
  model: string;
  leaseId: string;
  organizationId: string;
  provider: AutomationModelProvider;
  runId: string;
}

export interface AutomationModelBrokerClaim {
  apiKey: string;
  grantId: string;
  maxOutputTokens: number;
  model: string;
  organizationId: string;
  runId: string;
}

export interface AutomationContextBrokerClaim {
  account: {
    encryptedCredentials: string | null;
    externalAccountId: string;
    id: string;
    metadata: Record<string, unknown>;
    provider: string;
  };
  organizationId: string;
  resources: Array<{
    displayName: string;
    externalId: string;
    kind: string;
  }>;
  runId: string;
}

function assertPositiveIntegerWithin(
  value: number,
  maximum: number,
  description: string,
): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${description} must be between 1 and ${maximum}`);
  }
}

function validateGrantInput(
  input: CreateAutomationModelBrokerGrantInput,
  now: Date,
): void {
  if (!automationModelProviderSchema.safeParse(input.provider).success) {
    throw new Error("Unsupported automation model provider");
  }
  if (!modelIdentifierPattern.test(input.model)) {
    throw new Error("Automation model must be a normalized identifier");
  }
  if (!runIdentifierPattern.test(input.runId)) {
    throw new Error("Automation run ID must be a normalized identifier");
  }
  if (
    input.apiKey.length === 0 ||
    input.apiKey.length > 4_096 ||
    input.apiKey.trim() !== input.apiKey ||
    input.apiKey.includes("\0")
  ) {
    throw new Error("Automation model credential is invalid");
  }
  assertPositiveIntegerWithin(
    input.maxRequests,
    maximumGrantRequests,
    "Automation model request budget",
  );
  assertPositiveIntegerWithin(
    input.maxOutputTokensPerRequest,
    maximumOutputTokensPerRequest,
    "Automation model output-token limit",
  );
  const lifetimeMs = input.expiresAt.getTime() - now.getTime();
  if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0) {
    throw new Error("Automation model broker grant must expire in the future");
  }
  if (lifetimeMs > maximumGrantLifetimeMs) {
    throw new Error("Automation model broker grant cannot exceed one hour");
  }
}

export async function createAutomationModelBrokerGrant(
  input: CreateAutomationModelBrokerGrantInput,
  dependencies: CreateGrantDependencies = {},
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const now = dependencies.now?.() ?? new Date();
  validateGrantInput(input, now);
  const issuedToken = issueAutomationModelBrokerToken(
    dependencies.randomBytes,
  );
  const encryptedCredentials = encryptCredentials({ apiKey: input.apiKey, ...(input.contextOnly ? { contextOnly: true } : {}) });
  const rows = await getDatabase()
    .insert(automationModelBrokerGrants)
    .values({
      credentialKeyVersion: 1,
      encryptedCredentials,
      expiresAt: input.expiresAt,
      leaseId: input.leaseId,
      maxOutputTokensPerRequest: input.maxOutputTokensPerRequest,
      model: input.model,
      organizationId: input.organizationId,
      provider: input.provider,
      remainingOutputTokens:
        input.maxRequests * input.maxOutputTokensPerRequest,
      remainingRequests: input.maxRequests,
      runId: input.runId,
      tokenHash: issuedToken.tokenHash,
    })
    .returning({ id: automationModelBrokerGrants.id });
  const grant = rows[0];
  if (!grant) throw new Error("Unable to create automation model broker grant");
  return { id: grant.id, token: issuedToken.token, expiresAt: input.expiresAt };
}

export async function claimAutomationModelBrokerGrant(
  input: {
    model: string;
    provider: AutomationModelProvider;
    requestedMaxOutputTokens: number | null;
    tokenHash: string;
  },
  dependencies: ClaimGrantDependencies = {},
): Promise<AutomationModelBrokerClaim | null> {
  if (
    !tokenHashPattern.test(input.tokenHash) ||
    !modelIdentifierPattern.test(input.model) ||
    !automationModelProviderSchema.safeParse(input.provider).success
  ) {
    return null;
  }
  if (
    input.requestedMaxOutputTokens !== null &&
    (!Number.isSafeInteger(input.requestedMaxOutputTokens) ||
      input.requestedMaxOutputTokens <= 0 ||
      input.requestedMaxOutputTokens > maximumOutputTokensPerRequest)
  ) {
    return null;
  }

  const reservedOutputTokens = input.requestedMaxOutputTokens === null
    ? automationModelBrokerGrants.maxOutputTokensPerRequest
    : sql`${input.requestedMaxOutputTokens}`;
  const conditions = [
    eq(automationModelBrokerGrants.tokenHash, input.tokenHash),
    eq(automationModelBrokerGrants.provider, input.provider),
    eq(automationModelBrokerGrants.model, input.model),
    eq(automationModelBrokerGrants.credentialKeyVersion, 1),
    isNull(automationModelBrokerGrants.revokedAt),
    gt(automationModelBrokerGrants.expiresAt, dependencies.now?.() ?? new Date()),
    gt(automationModelBrokerGrants.remainingRequests, 0),
    gte(
      automationModelBrokerGrants.remainingOutputTokens,
      reservedOutputTokens,
    ),
  ];
  if (input.requestedMaxOutputTokens !== null) {
    conditions.push(
      gte(
        automationModelBrokerGrants.maxOutputTokensPerRequest,
        input.requestedMaxOutputTokens,
      ),
    );
  }

  const rows = await getDatabase()
    .update(automationModelBrokerGrants)
    .set({
      remainingOutputTokens: sql`${automationModelBrokerGrants.remainingOutputTokens} - ${reservedOutputTokens}`,
      remainingRequests: sql`${automationModelBrokerGrants.remainingRequests} - 1`,
    })
    .from(automationRuns)
    .where(and(
      ...conditions,
      eq(automationRuns.id, automationModelBrokerGrants.runId),
      eq(automationRuns.organizationId, automationModelBrokerGrants.organizationId),
      eq(automationRuns.leaseId, automationModelBrokerGrants.leaseId),
      eq(automationRuns.status, "running"),
    ))
    .returning({
      encryptedCredentials: automationModelBrokerGrants.encryptedCredentials,
      id: automationModelBrokerGrants.id,
      maxOutputTokensPerRequest:
        automationModelBrokerGrants.maxOutputTokensPerRequest,
      model: automationModelBrokerGrants.model,
      organizationId: automationModelBrokerGrants.organizationId,
      runId: automationModelBrokerGrants.runId,
    });
  const grant = rows[0];
  if (!grant) return null;

  const decrypt = dependencies.decryptCredentials ??
    ((encrypted: string) =>
      decryptCredentials<AutomationModelCredentials>(encrypted));
  const credentials = decrypt(grant.encryptedCredentials);
  if (credentials.contextOnly) return null;
  if (
    typeof credentials.apiKey !== "string" ||
    credentials.apiKey.length === 0
  ) {
    throw new Error("Automation model credential is unavailable");
  }

  return {
    apiKey: credentials.apiKey,
    grantId: grant.id,
    maxOutputTokens:
      input.requestedMaxOutputTokens ?? grant.maxOutputTokensPerRequest,
    model: grant.model,
    organizationId: grant.organizationId,
    runId: grant.runId,
  };
}

export async function revokeAutomationModelBrokerGrant(input: {
  grantId: string;
  organizationId: string;
  runId: string;
}): Promise<void> {
  await getDatabase()
    .delete(automationModelBrokerGrants)
    .where(
      and(
        eq(automationModelBrokerGrants.id, input.grantId),
        eq(automationModelBrokerGrants.organizationId, input.organizationId),
        eq(automationModelBrokerGrants.runId, input.runId),
      ),
    );
}

export async function purgeAutomationModelBrokerGrants(
  now = new Date(),
): Promise<number> {
  const deleted = await getDatabase()
    .delete(automationModelBrokerGrants)
    .where(
      or(
        isNotNull(automationModelBrokerGrants.revokedAt),
        lt(automationModelBrokerGrants.expiresAt, now),
      ),
    )
    .returning({ id: automationModelBrokerGrants.id });
  return deleted.length;
}

export async function resolveAutomationContextBrokerGrant(input: {
  integrationAccountId: string;
  tokenHash: string;
}, dependencies: { now?: () => Date } = {}): Promise<AutomationContextBrokerClaim | null> {
  if (!tokenHashPattern.test(input.tokenHash)) return null;
  const db = getDatabase();
  const rows = await db
    .select({
      encryptedCredentials: integrationAccounts.encryptedCredentials,
      externalAccountId: integrationAccounts.externalAccountId,
      id: integrationAccounts.id,
      metadata: integrationAccounts.metadata,
      organizationId: automationModelBrokerGrants.organizationId,
      provider: integrationAccounts.provider,
      runId: automationModelBrokerGrants.runId,
    })
    .from(automationModelBrokerGrants)
    .innerJoin(
      automationRuns,
      and(
        eq(automationRuns.id, automationModelBrokerGrants.runId),
        eq(automationRuns.organizationId, automationModelBrokerGrants.organizationId),
        eq(automationRuns.leaseId, automationModelBrokerGrants.leaseId),
        eq(automationRuns.status, "running"),
      ),
    )
    .innerJoin(
      automationVersionIntegrationAccounts,
      and(
        eq(
          automationVersionIntegrationAccounts.automationVersionId,
          automationRuns.automationVersionId,
        ),
        eq(
          automationVersionIntegrationAccounts.integrationAccountId,
          input.integrationAccountId,
        ),
        eq(automationVersionIntegrationAccounts.role, "context"),
      ),
    )
    .innerJoin(
      integrationAccounts,
      and(
        eq(integrationAccounts.id, input.integrationAccountId),
        eq(integrationAccounts.organizationId, automationRuns.organizationId),
        eq(integrationAccounts.status, "connected"),
      ),
    )
    .where(
      and(
        eq(automationModelBrokerGrants.tokenHash, input.tokenHash),
        isNull(automationModelBrokerGrants.revokedAt),
        gt(
          automationModelBrokerGrants.expiresAt,
          dependencies.now?.() ?? new Date(),
        ),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const resources = await db
    .select({
      displayName: integrationResources.displayName,
      externalId: integrationResources.externalId,
      kind: integrationResources.kind,
    })
    .from(integrationResources)
    .where(
      and(
        eq(integrationResources.integrationAccountId, row.id),
        eq(integrationResources.available, true),
      ),
    );
  return {
    account: {
      encryptedCredentials: row.encryptedCredentials,
      externalAccountId: row.externalAccountId,
      id: row.id,
      metadata: row.metadata,
      provider: row.provider,
    },
    organizationId: row.organizationId,
    resources,
    runId: row.runId,
  };
}
