import { z } from "zod";
import { decryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import { getOrganizationIntegrationAccount } from "../../../../packages/core/src/db/integrations.js";
import { organizationReceivesTelemetry } from "../../../../packages/core/src/db/organization-capabilities.js";
import { createTelemetryIngestKey } from "../../../../packages/core/src/db/telemetry-ingest-keys.js";
import {
  deleteTelemetrySource,
  getTelemetrySource,
  listTelemetrySources,
  listVercelInstallationProjectIds,
  revokeTelemetrySourceIngestKey,
  saveTelemetrySource,
} from "../../../../packages/core/src/db/telemetry-sources.js";
import { vercelCredentialsSchema } from "../../../../packages/core/src/integrations/vercel.js";
import { telemetryCollectorUrl } from "../../../../packages/core/src/telemetry/client.js";
import {
  createVercelDrains,
  deleteVercelDrain,
  VercelDrainError,
} from "../../../../packages/core/src/telemetry/sources/vercel-drains.js";
import { cellOrigin } from "../integrations/urls.js";

// Creating and removing Vercel drains, shared by the telemetry source routes
// and by connecting and disconnecting Vercel.
export type VercelSourceDependencies = {
  collectorUrl: () => string | null;
  createKey: typeof createTelemetryIngestKey;
  createVercelDrains: typeof createVercelDrains;
  decrypt: (encrypted: string) => Record<string, unknown>;
  deleteSource: typeof deleteTelemetrySource;
  deleteVercelDrain: typeof deleteVercelDrain;
  getAccount: typeof getOrganizationIntegrationAccount;
  getSource: typeof getTelemetrySource;
  ingestOrigin: () => string;
  listSources: typeof listTelemetrySources;
  receivesTelemetry: (organizationId: string) => Promise<boolean>;
  revokeKey: typeof revokeTelemetrySourceIngestKey;
  saveSource: typeof saveTelemetrySource;
  vercelProjectIds: typeof listVercelInstallationProjectIds;
};

// Wrapped, so modules are read only when used: tests of the integration
// routes mock some of them.
const defaultDependencies: VercelSourceDependencies = {
  collectorUrl: () => telemetryCollectorUrl(),
  createKey: (input) => createTelemetryIngestKey(input),
  createVercelDrains: (input) => createVercelDrains(input),
  decrypt: (encrypted) => decryptCredentials(encrypted),
  deleteSource: (input) => deleteTelemetrySource(input),
  deleteVercelDrain: (target, drainId) => deleteVercelDrain(target, drainId),
  getAccount: (input) => getOrganizationIntegrationAccount(input),
  getSource: (input) => getTelemetrySource(input),
  ingestOrigin: () => cellOrigin(),
  listSources: (organizationId) => listTelemetrySources(organizationId),
  receivesTelemetry: (organizationId) => organizationReceivesTelemetry(organizationId),
  revokeKey: (keyId) => revokeTelemetrySourceIngestKey(keyId),
  saveSource: (input) => saveTelemetrySource(input),
  vercelProjectIds: (integrationAccountId) => listVercelInstallationProjectIds(integrationAccountId),
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

// Creates the trace and log drains of one Vercel connection with a new
// ingest key. Creating them again replaces the earlier drains and key.
export async function createVercelSource(
  input: { integrationAccountId: string; organizationId: string; userId: string },
  dependencies: VercelSourceDependencies = defaultDependencies,
): Promise<{ ok: true; sourceId: string } | { error: string; ok: false; status: 404 | 502 }> {
  const target = await vercelTarget(dependencies, input.organizationId, input.integrationAccountId);
  if (!target) return { error: "Connect Vercel first", ok: false, status: 404 };
  const created = await dependencies.createKey({
    createdBy: input.userId,
    name: `Vercel ${target.credentials.configurationId}`,
    organizationId: input.organizationId,
  });
  const projectIds = target.account.metadata.projectSelection === "selected"
    ? await dependencies.vercelProjectIds(input.integrationAccountId)
    : null;
  const drainTarget = { accessToken: target.credentials.accessToken, teamId: target.credentials.teamId };
  let drains: Record<string, string>;
  try {
    drains = await dependencies.createVercelDrains({
      ...drainTarget,
      ingestKey: created.token,
      ingestOrigin: dependencies.ingestOrigin(),
      name: `superlog-${input.organizationId.slice(0, 8)}`,
      projectIds,
    });
  } catch (error) {
    await dependencies.revokeKey(created.key.id);
    const status = error instanceof VercelDrainError ? error.status : 502;
    const message = status === 403
      ? "Vercel did not allow Superlog to create drains. Drains need a Pro or Enterprise team, and the Superlog integration needs the Drains permission. Reconnect Vercel to grant it."
      : `Vercel could not create the drains: ${errorMessage(error)}`;
    return { error: message, ok: false, status: 502 };
  }
  // Drains Vercel does not delete now are kept and tried again later.
  const previous = (await dependencies.listSources(input.organizationId)).find(
    (source) => source.provider === "vercel" && source.externalId === target.credentials.configurationId,
  );
  const { failed } = await deleteDrains(
    dependencies,
    drainTarget,
    vercelDrainIds(previous?.state).filter((id) => !Object.values(drains).includes(id)),
  );
  let saved: Awaited<ReturnType<typeof dependencies.saveSource>>;
  try {
    saved = await dependencies.saveSource({
      createdBy: input.userId,
      displayName: target.credentials.teamId ? `Vercel team ${target.credentials.teamId}` : "Vercel",
      externalId: target.credentials.configurationId,
      ingestKeyId: created.key.id,
      integrationAccountId: input.integrationAccountId,
      organizationId: input.organizationId,
      provider: "vercel",
      state: { drains, staleDrains: failed },
      status: "active",
    });
  } catch (error) {
    // Unsaved drains could not be removed later, so remove them now.
    await deleteDrains(dependencies, drainTarget, Object.values(drains));
    await dependencies.revokeKey(created.key.id).catch(() => undefined);
    throw error;
  }
  if (saved.previousIngestKeyId) await dependencies.revokeKey(saved.previousIngestKeyId);
  return { ok: true, sourceId: saved.id };
}

// Connecting Vercel from Signal setup creates the drains straight away, where
// the workspace can receive telemetry and has none from this installation
// yet. A failure leaves the connection in place; its manage page offers to
// create the drains again and says why they failed.
export async function createVercelSourceAfterConnect(
  input: { integrationAccountId: string; organizationId: string; userId: string },
  dependencies: VercelSourceDependencies = defaultDependencies,
): Promise<"created" | "exists" | "failed" | "unavailable"> {
  if (!dependencies.collectorUrl() || !(await dependencies.receivesTelemetry(input.organizationId))) return "unavailable";
  const existing = (await dependencies.listSources(input.organizationId)).some(
    (source) => source.provider === "vercel" && source.integrationAccountId === input.integrationAccountId,
  );
  if (existing) return "exists";
  const created = await createVercelSource(input, dependencies);
  return created.ok ? "created" : "failed";
}
