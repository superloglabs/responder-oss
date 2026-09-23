import { and, eq } from "drizzle-orm";
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
}): Promise<{ apiKey: string; provider: AutomationModelProvider } | null> {
  const rows = await getDatabase()
    .select({
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
  const decrypted = decryptCredentials<StoredModelCredential>(
    credential.encryptedCredentials,
  );
  if (!decrypted.apiKey) return null;
  return { apiKey: decrypted.apiKey, provider: credential.provider };
}

export async function markOrganizationModelCredentialValidated(input: {
  credentialId: string;
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
