import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import {
  defaultSandboxImageSettings,
  type SandboxImageBase,
  type SandboxImageRecord,
  type SandboxImageSettings,
} from "../sandbox-image.js";
import { getDatabase } from "./client.js";
import {
  sandboxImageSettings,
  sandboxImageSnapshotDeletions,
  sandboxImages,
} from "./schema.js";

const settingsSelection = {
  packages: sandboxImageSettings.packages,
  setupScript: sandboxImageSettings.setupScript,
  startCommand: sandboxImageSettings.startCommand,
  vcpus: sandboxImageSettings.vcpus,
};

export async function getSandboxImageSettings(
  organizationId: string,
): Promise<SandboxImageSettings> {
  const [row] = await getDatabase()
    .select(settingsSelection)
    .from(sandboxImageSettings)
    .where(eq(sandboxImageSettings.organizationId, organizationId));
  return row ?? defaultSandboxImageSettings;
}

export async function getSandboxImageRebuildRequestedAt(
  organizationId: string,
): Promise<Date | null> {
  const [row] = await getDatabase()
    .select({ rebuildRequestedAt: sandboxImageSettings.rebuildRequestedAt })
    .from(sandboxImageSettings)
    .where(eq(sandboxImageSettings.organizationId, organizationId));
  return row?.rebuildRequestedAt ?? null;
}

export async function getSandboxImageRequestedAt(
  organizationId: string,
): Promise<Date | null> {
  const [row] = await getDatabase()
    .select({ imageRequestedAt: sandboxImageSettings.imageRequestedAt })
    .from(sandboxImageSettings)
    .where(eq(sandboxImageSettings.organizationId, organizationId));
  return row?.imageRequestedAt ?? null;
}

// `imageRequested` records that the saved settings need a new build.
export async function saveSandboxImageSettings(
  organizationId: string,
  settings: SandboxImageSettings,
  updatedBy: string | null,
  imageRequested: boolean,
  now: Date = new Date(),
): Promise<void> {
  const values = {
    ...settings,
    ...(imageRequested ? { imageRequestedAt: now } : {}),
    updatedAt: now,
    updatedBy,
  };
  await getDatabase()
    .insert(sandboxImageSettings)
    .values({ organizationId, ...values })
    .onConflictDoUpdate({ target: sandboxImageSettings.organizationId, set: values });
}

export async function requestSandboxImageRebuild(
  organizationId: string,
  now: Date = new Date(),
): Promise<void> {
  await getDatabase()
    .update(sandboxImageSettings)
    .set({ imageRequestedAt: now, rebuildRequestedAt: now })
    .where(eq(sandboxImageSettings.organizationId, organizationId));
}

const imageSelection = {
  error: sandboxImages.error,
  finishedAt: sandboxImages.finishedAt,
  key: sandboxImages.key,
  log: sandboxImages.log,
  snapshotBaseId: sandboxImages.snapshotBaseId,
  snapshotBuiltAt: sandboxImages.snapshotBuiltAt,
  snapshotId: sandboxImages.snapshotId,
  snapshotKey: sandboxImages.snapshotKey,
  snapshotRegion: sandboxImages.snapshotRegion,
  snapshotStartCommand: sandboxImages.snapshotStartCommand,
  startedAt: sandboxImages.startedAt,
  status: sandboxImages.status,
};

export async function getSandboxImage(
  organizationId: string,
): Promise<SandboxImageRecord | null> {
  const [row] = await getDatabase()
    .select(imageSelection)
    .from(sandboxImages)
    .where(eq(sandboxImages.organizationId, organizationId));
  return row ?? null;
}

// The list leaves out the build log, which the worker does not read.
const imageStateSelection = Object.fromEntries(
  Object.entries(imageSelection).filter(([field]) => field !== "log"),
) as Omit<typeof imageSelection, "log">;

export interface SandboxImageWorkspace {
  image: Omit<SandboxImageRecord, "log"> | null;
  organizationId: string;
  rebuildRequestedAt: Date | null;
  settings: SandboxImageSettings;
}

// Workspaces whose settings need a snapshot or that still have one, for the
// worker to check that each matches its settings and the current base.
export async function listSandboxImageWorkspaces(): Promise<SandboxImageWorkspace[]> {
  const database = getDatabase();
  const [configured, imagesWithoutSettings] = await Promise.all([
    database
      .select({
        image: imageStateSelection,
        organizationId: sandboxImageSettings.organizationId,
        rebuildRequestedAt: sandboxImageSettings.rebuildRequestedAt,
        settings: settingsSelection,
      })
      .from(sandboxImageSettings)
      .leftJoin(sandboxImages, eq(sandboxImages.organizationId, sandboxImageSettings.organizationId))
      .where(sql`jsonb_array_length(${sandboxImageSettings.packages}) > 0 OR ${sandboxImageSettings.setupScript} <> '' OR ${sandboxImages.organizationId} IS NOT NULL`),
    database
      .select({ image: imageStateSelection, organizationId: sandboxImages.organizationId })
      .from(sandboxImages)
      .leftJoin(sandboxImageSettings, eq(sandboxImageSettings.organizationId, sandboxImages.organizationId))
      .where(isNull(sandboxImageSettings.organizationId)),
  ]);
  return [
    ...configured.map((row) => ({
      image: row.image?.key ? row.image as Omit<SandboxImageRecord, "log"> : null,
      organizationId: row.organizationId,
      rebuildRequestedAt: row.rebuildRequestedAt,
      settings: row.settings,
    })),
    ...imagesWithoutSettings.map((row) => ({
      image: row.image,
      organizationId: row.organizationId,
      rebuildRequestedAt: null,
      settings: defaultSandboxImageSettings,
    })),
  ];
}

// Starts a build of `key`, keeping the last snapshot that built for runs to
// use meanwhile.
export async function startSandboxImageBuild(
  organizationId: string,
  key: string,
  now: Date = new Date(),
): Promise<void> {
  const values = {
    error: null,
    finishedAt: null,
    key,
    log: "",
    startedAt: now,
    status: "building" as const,
  };
  await getDatabase()
    .insert(sandboxImages)
    .values({ organizationId, ...values })
    .onConflictDoUpdate({ target: sandboxImages.organizationId, set: values });
}

export async function recordSandboxImageBuildLog(
  organizationId: string,
  key: string,
  log: string,
): Promise<void> {
  await getDatabase()
    .update(sandboxImages)
    .set({ log })
    .where(and(eq(sandboxImages.organizationId, organizationId), eq(sandboxImages.key, key)));
}

// Records the snapshot a build of `key` made and the start command that goes
// with it. The snapshot it replaces is queued for deletion by the trigger on
// sandbox_images. A build whose key a newer build has replaced is not
// recorded, and its snapshot is deleted.
export async function completeSandboxImageBuild(
  organizationId: string,
  key: string,
  snapshot: SandboxImageBase & { builtSnapshotId: string; startCommand: string },
  log: string,
  now: Date = new Date(),
): Promise<void> {
  const database = getDatabase();
  const updated = await database
    .update(sandboxImages)
    .set({
      error: null,
      finishedAt: now,
      log,
      snapshotBaseId: snapshot.snapshotId,
      // Recording the same snapshot again keeps the time it was built.
      snapshotBuiltAt: sql`CASE WHEN ${sandboxImages.snapshotId} IS DISTINCT FROM ${snapshot.builtSnapshotId} THEN ${now} ELSE ${sandboxImages.snapshotBuiltAt} END`,
      snapshotId: snapshot.builtSnapshotId,
      snapshotKey: key,
      snapshotRegion: snapshot.region,
      snapshotStartCommand: snapshot.startCommand,
      status: "ready",
    })
    .where(and(eq(sandboxImages.organizationId, organizationId), eq(sandboxImages.key, key)))
    .returning({ organizationId: sandboxImages.organizationId });
  if (updated.length === 0) await queueSandboxImageSnapshotDeletion(snapshot.builtSnapshotId, now);
}

export async function queueSandboxImageSnapshotDeletion(
  snapshotId: string,
  deleteAfter: Date = new Date(),
): Promise<void> {
  await getDatabase()
    .insert(sandboxImageSnapshotDeletions)
    .values({ deleteAfter, snapshotId })
    .onConflictDoNothing();
}

export async function listDueSandboxImageSnapshotDeletions(
  now: Date = new Date(),
  limit = 20,
): Promise<Array<{ attempts: number; snapshotId: string }>> {
  return getDatabase()
    .select({
      attempts: sandboxImageSnapshotDeletions.attempts,
      snapshotId: sandboxImageSnapshotDeletions.snapshotId,
    })
    .from(sandboxImageSnapshotDeletions)
    .where(lte(sandboxImageSnapshotDeletions.deleteAfter, now))
    .orderBy(asc(sandboxImageSnapshotDeletions.deleteAfter))
    .limit(limit);
}

export async function finishSandboxImageSnapshotDeletion(snapshotId: string): Promise<void> {
  await getDatabase()
    .delete(sandboxImageSnapshotDeletions)
    .where(eq(sandboxImageSnapshotDeletions.snapshotId, snapshotId));
}

export async function retrySandboxImageSnapshotDeletion(
  snapshotId: string,
  error: string,
  retryAt: Date,
): Promise<void> {
  await getDatabase()
    .update(sandboxImageSnapshotDeletions)
    .set({
      attempts: sql`${sandboxImageSnapshotDeletions.attempts} + 1`,
      deleteAfter: retryAt,
      lastError: error.slice(0, 500),
    })
    .where(eq(sandboxImageSnapshotDeletions.snapshotId, snapshotId));
}

export async function failSandboxImageBuild(
  organizationId: string,
  key: string,
  error: string,
  log: string,
  now: Date = new Date(),
): Promise<void> {
  await getDatabase()
    .update(sandboxImages)
    .set({ error, finishedAt: now, log, status: "failed" })
    .where(and(eq(sandboxImages.organizationId, organizationId), eq(sandboxImages.key, key)));
}

// Forgets the workspace's snapshot once its settings no longer need one. The
// trigger on sandbox_images queues the snapshot for deletion.
export async function clearSandboxImage(organizationId: string): Promise<void> {
  await getDatabase()
    .delete(sandboxImages)
    .where(eq(sandboxImages.organizationId, organizationId));
}
