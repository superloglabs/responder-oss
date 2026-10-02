import { z } from "zod";
import {
  decryptCredentials,
  encryptCredentials,
} from "../../../../packages/core/src/credentials/encryption.js";
import { withIntegrationAccountCredentialLease } from "../../../../packages/core/src/db/integrations.js";
import { refreshSentryGrant, sentryErrorNeedsReconnect } from "./sentry.js";

const sentryCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.string().nullable().optional(),
  installationId: z.uuid(),
  refreshToken: z.string().min(1),
});

export class StoredSentryConnectionError extends Error {
  constructor() {
    super("Stored Sentry connection is invalid");
    this.name = "StoredSentryConnectionError";
  }
}

export class SentryConnectionChangedError extends Error {
  constructor() {
    super("Sentry connection changed during refresh");
    this.name = "SentryConnectionChangedError";
  }
}

export function getSentryOrganizationSlug(metadata: Record<string, unknown>): string {
  try {
    return z.string().min(1).parse(metadata.organizationSlug);
  } catch {
    throw new StoredSentryConnectionError();
  }
}

export async function getFreshSentryCredentials(input: {
  accountId: string;
  allowedStatuses?: Array<"connected" | "error" | "pending">;
  forceRefresh?: boolean;
  organizationId: string;
}) {
  const fresh = await withIntegrationAccountCredentialLease({
    allowedStatuses: input.allowedStatuses ?? ["connected"],
    integrationAccountId: input.accountId,
    organizationId: input.organizationId,
    operation: async (encryptedCredentials) => {
      let current: z.infer<typeof sentryCredentialsSchema>;
      try {
        current = sentryCredentialsSchema.parse(
          decryptCredentials<Record<string, unknown>>(encryptedCredentials),
        );
      } catch {
        throw new StoredSentryConnectionError();
      }
      const expiresAt = current.expiresAt
        ? Date.parse(current.expiresAt)
        : Number.POSITIVE_INFINITY;
      if (
        !input.forceRefresh &&
        Number.isFinite(expiresAt) &&
        expiresAt > Date.now() + 60_000
      ) {
        return {
          value: { credentials: current, encryptedCredentials },
        };
      }

      const authorization = await refreshSentryGrant({
        installationId: current.installationId,
        refreshToken: current.refreshToken,
      });
      const refreshed = {
        accessToken: authorization.token,
        expiresAt: authorization.expiresAt ?? null,
        installationId: current.installationId,
        refreshToken: authorization.refreshToken,
      };
      const refreshedEncryptedCredentials = encryptCredentials(refreshed);
      return {
        encryptedCredentials: refreshedEncryptedCredentials,
        status: "connected" as const,
        value: {
          credentials: refreshed,
          encryptedCredentials: refreshedEncryptedCredentials,
        },
      };
    },
    provider: "sentry",
    statusOnError: (error) =>
      error instanceof StoredSentryConnectionError ||
        sentryErrorNeedsReconnect(error)
        ? "error"
        : undefined,
  });
  if (!fresh) throw new SentryConnectionChangedError();
  return fresh;
}
