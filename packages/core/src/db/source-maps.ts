import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { gunzipSync, gzipSync } from "node:zlib";
import { getDatabase } from "./client.js";
import { sourceMaps } from "./schema.js";

// Source maps that have not symbolicated an error for this long are deleted.
export const sourceMapRetentionMs = 30 * 86_400_000;

export async function saveSourceMap(input: {
  content: string;
  debugId: string;
  file: string;
  organizationId: string;
  release: string | null;
}): Promise<void> {
  const values = {
    content: gzipSync(input.content),
    debugId: input.debugId,
    file: input.file,
    organizationId: input.organizationId,
    release: input.release,
    size: Buffer.byteLength(input.content),
  };
  await getDatabase()
    .insert(sourceMaps)
    .values(values)
    .onConflictDoUpdate({
      set: { content: values.content, createdAt: new Date(), file: values.file, release: values.release, size: values.size },
      target: [sourceMaps.organizationId, sourceMaps.debugId],
    });
}

// The workspace's maps for these debug IDs, as JSON text by debug ID. Marks
// them used at most once a day, so retention keeps maps that still match
// live errors.
export async function loadSourceMaps(organizationId: string, debugIds: string[], now = new Date()): Promise<Map<string, string>> {
  if (debugIds.length === 0) return new Map();
  const database = getDatabase();
  const matching = and(eq(sourceMaps.organizationId, organizationId), inArray(sourceMaps.debugId, debugIds));
  const rows = await database
    .select({ content: sourceMaps.content, debugId: sourceMaps.debugId })
    .from(sourceMaps)
    .where(matching);
  if (rows.length > 0) {
    const dayAgo = new Date(now.getTime() - 86_400_000);
    await database
      .update(sourceMaps)
      .set({ lastUsedAt: now })
      .where(and(matching, or(isNull(sourceMaps.lastUsedAt), lt(sourceMaps.lastUsedAt, dayAgo))));
  }
  return new Map(rows.map((row) => [row.debugId, gunzipSync(row.content).toString("utf8")]));
}

export async function purgeSourceMaps(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - sourceMapRetentionMs);
  const deleted = await getDatabase()
    .delete(sourceMaps)
    .where(or(lt(sourceMaps.lastUsedAt, cutoff), and(isNull(sourceMaps.lastUsedAt), lt(sourceMaps.createdAt, cutoff))))
    .returning({ id: sourceMaps.id });
  return deleted.length;
}

