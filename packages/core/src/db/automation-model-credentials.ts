import { parseSubscriptionAuth } from "../automations/chatgpt-subscription.js";
import { and, eq, isNull } from "drizzle-orm";
import type { AutomationModelProvider } from "../automations/config.js";
import {
  decryptCredentials,
  encryptCredentials,
} from "../credentials/encryption.js";
import { getDatabase } from "./client.js";
import { organizationModelCredentials } from "./schema.js";

interface StoredModelCredential extends Record<string, unknown> {
  apiKey: string;
}

function validateApiKey(apiKey: string): void {
  if (
    apiKey.length === 0 ||
    apiKey.length > 4_096 ||
    apiKey.trim() !== apiKey ||
    apiKey.includes("\0")
  ) {
    throw new Error("Model provider key is invalid");
  }
}

export async function createOrganizationModelCredential(input: {
  apiKey: string;
  label: string;
  organizationId: string;
  provider: AutomationModelProvider;
}) {
  validateApiKey(input.apiKey);
  const rows = await getDatabase()
    .insert(organizationModelCredentials)
    .values({
      credentialKeyVersion: 1,
      encryptedCredentials: encryptCredentials({ apiKey: input.apiKey }),
      label: input.label,
      lastFour: input.apiKey.slice(-4),
      organizationId: input.organizationId,
      provider: input.provider,
      status: "active",
    })
    .returning({ id: organizationModelCredentials.id });
  const credential = rows[0];
  if (!credential) throw new Error("Unable to create model credential");
  return { id: credential.id };
}

export async function rotateOrganizationModelCredential(input: {
  apiKey: string;
  credentialId: string;
  organizationId: string;
}): Promise<boolean> {
  validateApiKey(input.apiKey);
  const rows = await getDatabase()
    .update(organizationModelCredentials)
    .set({
      credentialKeyVersion: 1,
      encryptedCredentials: encryptCredentials({ apiKey: input.apiKey }),
      lastFour: input.apiKey.slice(-4),
      status: "active",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(organizationModelCredentials.id, input.credentialId),
        eq(organizationModelCredentials.organizationId, input.organizationId),
        eq(organizationModelCredentials.authType, "api_key"),
      ),
    )
    .returning({ id: organizationModelCredentials.id });
  return rows.length > 0;
}

export async function listOrganizationModelCredentials(organizationId: string) {
  return getDatabase()
    .select({
      id: organizationModelCredentials.id,
      label: organizationModelCredentials.label,
      authType: organizationModelCredentials.authType,
      lastFour: organizationModelCredentials.lastFour,
      lastValidatedAt: organizationModelCredentials.lastValidatedAt,
      provider: organizationModelCredentials.provider,
      status: organizationModelCredentials.status,
      createdAt: organizationModelCredentials.createdAt,
      updatedAt: organizationModelCredentials.updatedAt,
    })
    .from(organizationModelCredentials)
    .where(eq(organizationModelCredentials.organizationId, organizationId));
}

export async function getOrganizationModelCredential(input: {
  credentialId: string;
  organizationId: string;
  provider?: AutomationModelProvider;
}): Promise<{
  apiKey: string;
  provider: AutomationModelProvider;
  subscription?: { credentialId: string; authJson: string };
} | null> {
  const rows = await getDatabase()
    .select({
      authType: organizationModelCredentials.authType,
      credentialKeyVersion: organizationModelCredentials.credentialKeyVersion,
      encryptedCredentials: organizationModelCredentials.encryptedCredentials,
      provider: organizationModelCredentials.provider,
      status: organizationModelCredentials.status,
    })
    .from(organizationModelCredentials)
    .where(
      and(
        eq(organizationModelCredentials.id, input.credentialId),
        eq(organizationModelCredentials.organizationId, input.organizationId),
        ...(input.provider
          ? [eq(organizationModelCredentials.provider, input.provider)]
          : []),
        eq(organizationModelCredentials.status, "active"),
      ),
    )
    .limit(1);
  const credential = rows[0];
  if (!credential || credential.credentialKeyVersion !== 1) return null;
  if (credential.authType === "chatgpt_subscription") {
    if (credential.provider !== "openai") return null;
    const stored = decryptCredentials<{ authJson: string }>(
      credential.encryptedCredentials,
    );
    parseSubscriptionAuth(stored.authJson);
    return {
      apiKey: "subscription-context-only",
      provider: "openai",
      subscription: {
        credentialId: input.credentialId,
        authJson: stored.authJson,
      },
    };
  }

  const decrypted = decryptCredentials<StoredModelCredential>(
    credential.encryptedCredentials,
  );
  if (!decrypted.apiKey) return null;
  return { apiKey: decrypted.apiKey, provider: credential.provider };
}

export async function getOrganizationModelCredentialForValidation(input: {
  credentialId: string;
  organizationId: string;
}): Promise<{
  apiKey: string;
  encryptedCredentials: string;
  provider: AutomationModelProvider;
} | null> {
  const rows = await getDatabase()
    .select({
      authType: organizationModelCredentials.authType,
      credentialKeyVersion: organizationModelCredentials.credentialKeyVersion,
      encryptedCredentials: organizationModelCredentials.encryptedCredentials,
      provider: organizationModelCredentials.provider,
    })
    .from(organizationModelCredentials)
    .where(
      and(
        eq(organizationModelCredentials.id, input.credentialId),
        eq(organizationModelCredentials.organizationId, input.organizationId),
      ),
    )
    .limit(1);
  const credential = rows[0];
  if (
    !credential ||
    credential.credentialKeyVersion !== 1 ||
    credential.authType === "chatgpt_subscription"
  )
    return null;
  const decrypted = decryptCredentials<StoredModelCredential>(
    credential.encryptedCredentials,
  );
  if (!decrypted.apiKey) return null;
  return {
    apiKey: decrypted.apiKey,
    encryptedCredentials: credential.encryptedCredentials,
    provider: credential.provider,
  };
}

export async function markOrganizationModelCredentialValidated(input: {
  credentialId: string;
  encryptedCredentials: string;
  organizationId: string;
  valid: boolean;
}): Promise<void> {
  await getDatabase()
    .update(organizationModelCredentials)
    .set({
      lastValidatedAt: new Date(),
      status: input.valid ? "active" : "invalid",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(organizationModelCredentials.id, input.credentialId),
        eq(organizationModelCredentials.organizationId, input.organizationId),
        eq(
          organizationModelCredentials.encryptedCredentials,
          input.encryptedCredentials,
        ),
      ),
    );
}

export async function deleteOrganizationModelCredential(input: {
  credentialId: string;
  organizationId: string;
}): Promise<boolean> {
  const rows = await getDatabase()
    .delete(organizationModelCredentials)
    .where(
      and(
        eq(organizationModelCredentials.id, input.credentialId),
        eq(organizationModelCredentials.organizationId, input.organizationId),
      ),
    )
    .returning({ id: organizationModelCredentials.id });
  return rows.length > 0;
}

export async function acquireSubscriptionCredential(input: {
  credentialId: string;
  organizationId: string;
  leaseId: string;
  expiresAt: Date;
}): Promise<string> {
  const rows = await getDatabase()
    .update(organizationModelCredentials)
    .set({
      subscriptionLeaseId: input.leaseId,
      subscriptionLeaseExpiresAt: input.expiresAt,
    })
    .where(
      and(
        eq(organizationModelCredentials.id, input.credentialId),
        eq(organizationModelCredentials.organizationId, input.organizationId),
        eq(organizationModelCredentials.authType, "chatgpt_subscription"),
        eq(organizationModelCredentials.status, "active"),
        // Time alone cannot prove the old sandbox stopped. Fail closed until its owner releases.
        isNull(organizationModelCredentials.subscriptionLeaseId),
      ),
    )
    .returning({
      encryptedCredentials: organizationModelCredentials.encryptedCredentials,
    });
  if (!rows[0])
    throw new Error(
      "This ChatGPT subscription is already running an automation or needs reconnecting. Try again when the current run finishes.",
    );
  const { authJson } = decryptCredentials<{ authJson: string }>(
    rows[0].encryptedCredentials,
  );
  parseSubscriptionAuth(authJson);
  return authJson;
}

export async function persistSubscriptionCredential(input: {
  credentialId: string;
  organizationId: string;
  leaseId: string;
  authJson: string;
  previousAccountId: string;
}): Promise<void> {
  if (
    parseSubscriptionAuth(input.authJson).tokens.account_id !==
    input.previousAccountId
  )
    throw new Error("Subscription account changed during the run");
  const rows = await getDatabase()
    .update(organizationModelCredentials)
    .set({
      encryptedCredentials: encryptCredentials({ authJson: input.authJson }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(organizationModelCredentials.id, input.credentialId),
        eq(organizationModelCredentials.organizationId, input.organizationId),
        eq(organizationModelCredentials.authType, "chatgpt_subscription"),
        eq(organizationModelCredentials.subscriptionLeaseId, input.leaseId),
      ),
    )
    .returning({ id: organizationModelCredentials.id });
  if (!rows.length) throw new Error("Subscription credential lease was lost");
}

export async function releaseSubscriptionCredential(input: {
  credentialId: string;
  organizationId: string;
  leaseId: string;
}): Promise<void> {
  await getDatabase()
    .update(organizationModelCredentials)
    .set({ subscriptionLeaseId: null, subscriptionLeaseExpiresAt: null })
    .where(
      and(
        eq(organizationModelCredentials.id, input.credentialId),
        eq(organizationModelCredentials.organizationId, input.organizationId),
        eq(organizationModelCredentials.subscriptionLeaseId, input.leaseId),
      ),
    );
}
