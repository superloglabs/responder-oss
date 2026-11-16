import { z } from "zod";
import { decryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import { getOrganizationIntegrationAccount } from "../../../../packages/core/src/db/integrations.js";
import {
  deleteTelemetrySource,
  getTelemetrySource,
  listTelemetrySources,
  revokeTelemetrySourceIngestKey,
} from "../../../../packages/core/src/db/telemetry-sources.js";
import { vercelCredentialsSchema } from "../../../../packages/core/src/integrations/vercel.js";
import { deleteVercelDrain, VercelDrainError } from "../../../../packages/core/src/telemetry/sources/vercel-drains.js";

// Removing Vercel drains, shared by the telemetry source routes and by
// disconnecting a Vercel connection. Kept apart from the source routes so the
// integration routes can use it without loading the telemetry client.
export type VercelSourceDependencies = {
  decrypt: (encrypted: string) => Record<string, unknown>;
  deleteSource: typeof deleteTelemetrySource;
  deleteVercelDrain: typeof deleteVercelDrain;
  getAccount: typeof getOrganizationIntegrationAccount;
  getSource: typeof getTelemetrySource;
  listSources: typeof listTelemetrySources;
  revokeKey: typeof revokeTelemetrySourceIngestKey;
};

// Wrapped, so modules are read only when used: tests of the integration
// routes mock some of them.
const defaultDependencies: VercelSourceDependencies = {
  decrypt: (encrypted) => decryptCredentials(encrypted),
  deleteSource: (input) => deleteTelemetrySource(input),
  deleteVercelDrain: (target, drainId) => deleteVercelDrain(target, drainId),
  getAccount: (input) => getOrganizationIntegrationAccount(input),
  getSource: (input) => getTelemetrySource(input),
  listSources: (organizationId) => listTelemetrySources(organizationId),
  revokeKey: (keyId) => revokeTelemetrySourceIngestKey(keyId),
};

// Stale drains are earlier drains that Vercel did not delete; removing the
// source or reconnecting tries them again.
const vercelStateSchema = z.object({
  drains: z.record(z.string(), z.string()).default({}),
  staleDrains: z.array(z.string()).default([]),
});

export function vercelDrainIds(state: unknown): string[] {
  const parsed = vercelStateSchema.safeParse(state ?? {});
  return parsed.success ? [...Object.values(parsed.data.drains), ...parsed.data.staleDrains] : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Deletes drains and returns the IDs Vercel did not delete.
export async function deleteDrains(
  dependencies: Pick<VercelSourceDependencies, "deleteVercelDrain">,
  target: { accessToken: string; teamId: string | null },
  ids: string[],
) {
  const results = await Promise.allSettled(ids.map((id) => dependencies.deleteVercelDrain(target, id)));
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  return {
    failed: ids.filter((_id, index) => results[index]?.status === "rejected"),
    reason: rejected[0]?.reason as unknown,
    // Vercel refused the installation's token: the installation is gone,
    // and Vercel deleted its drains with it.
    accessGone: rejected.length > 0 && rejected.every((result) =>
      result.reason instanceof VercelDrainError && (result.reason.status === 401 || result.reason.status === 403)),
  };
}

export async function vercelTarget(dependencies: Pick<VercelSourceDependencies, "decrypt" | "getAccount">, organizationId: string, integrationAccountId: string) {
  const account = await dependencies.getAccount({ integrationAccountId, organizationId, provider: "vercel" });
  if (!account?.encryptedCredentials || account.status !== "connected") return null;
  const credentials = vercelCredentialsSchema.parse(dependencies.decrypt(account.encryptedCredentials));
  return { account, credentials };
}

// What removing a Vercel connection does first: delete the drains of its
// sources, revoke their keys, and remove them. While Vercel keeps a drain,
// the connection stays, so Superlog keeps the token to try again.
export async function removeVercelSourcesBeforeDisconnect(
  input: { integrationAccountId: string; organizationId: string },
  dependencies: VercelSourceDependencies = defaultDependencies,
): Promise<{ ok: true } | { error: string; ok: false }> {
  const sources = (await dependencies.listSources(input.organizationId)).filter(
    (source) => source.provider === "vercel" && source.integrationAccountId === input.integrationAccountId,
  );
  if (sources.length === 0) return { ok: true };
  const target = await vercelTarget(dependencies, input.organizationId, input.integrationAccountId).catch(() => null);
  for (const source of sources) {
    if (target) {
      const { accessGone, failed, reason } = await deleteDrains(
        dependencies,
        { accessToken: target.credentials.accessToken, teamId: target.credentials.teamId },
        vercelDrainIds(source.state),
      );
      if (failed.length > 0 && !accessGone) {
        return { error: `Vercel could not remove the drains: ${errorMessage(reason)}`, ok: false };
      }
    }
    // The source list leaves out the key ID; the full record has it.
    const full = await dependencies.getSource({ id: source.id, organizationId: input.organizationId });
    if (full?.ingestKeyId) await dependencies.revokeKey(full.ingestKeyId);
    await dependencies.deleteSource({ id: source.id, organizationId: input.organizationId });
  }
  return { ok: true };
}
