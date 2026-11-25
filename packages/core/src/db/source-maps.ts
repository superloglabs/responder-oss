import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { getDatabase } from "./client.js";
import { sourceMaps } from "./schema.js";

// Source maps that have not symbolicated an error for this long are deleted.
export const sourceMapRetentionMs = 30 * 86_400_000;

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

// How many maps, and how many bytes of them, one load reads. A stack touches
// a few files; maps past these limits leave their frames minified.
export const sourceMapLoadLimits = { maxMaps: 32, maxTotalBytes: 128 * 1024 * 1024 };
const maximumRequestedMaps = 256;

// The maps to read, in order, while they fit the limits.
export function chooseSourceMaps(rows: Array<{ debugId: string; size: number }>, limits = sourceMapLoadLimits): string[] {
  const chosen: string[] = [];
  let total = 0;
  for (const row of rows) {
    if (chosen.length >= limits.maxMaps) break;
    if (total + row.size > limits.maxTotalBytes) continue;
    total += row.size;
    chosen.push(row.debugId);
  }
  return chosen;
}

export async function saveSourceMap(input: {
  content: string;
  debugId: string;
  file: string;
  organizationId: string;
  release: string | null;
}): Promise<void> {
  const values = {
    content: await gzipAsync(input.content),
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
  const requested = and(eq(sourceMaps.organizationId, organizationId), inArray(sourceMaps.debugId, debugIds.slice(0, maximumRequestedMaps)));
  const sizes = await database
    .select({ debugId: sourceMaps.debugId, size: sourceMaps.size })
    .from(sourceMaps)
    .where(requested);
  if (sizes.length === 0) return new Map();
  // Every map an error still names is marked used, read now or not, so
  // retention keeps it.
  const dayAgo = new Date(now.getTime() - 86_400_000);
  await database
    .update(sourceMaps)
    .set({ lastUsedAt: now })
    .where(and(requested, or(isNull(sourceMaps.lastUsedAt), lt(sourceMaps.lastUsedAt, dayAgo))));
  // The stack's order decides which maps fit, not the order rows come back in.
  const order = new Map(debugIds.map((debugId, index) => [debugId, index]));
  sizes.sort((left, right) => (order.get(left.debugId) ?? 0) - (order.get(right.debugId) ?? 0));
  const chosen = chooseSourceMaps(sizes);
  if (chosen.length === 0) return new Map();
  const rows = await database
    .select({ content: sourceMaps.content, debugId: sourceMaps.debugId, size: sourceMaps.size })
    .from(sourceMaps)
    .where(and(eq(sourceMaps.organizationId, organizationId), inArray(sourceMaps.debugId, chosen)));
  // An upload between the two reads can replace a chosen map, so the limits
  // are checked again on the rows read.
  const kept = new Set(chooseSourceMaps(rows));
  const maps = new Map<string, string>();
  for (const row of rows) {
    if (!kept.has(row.debugId)) continue;
    // The stored size is the map's size before compression.
    const content = await gunzipAsync(row.content, { maxOutputLength: Math.max(1, row.size) }).catch(() => null);
    if (content) maps.set(row.debugId, content.toString("utf8"));
  }
  return maps;
}

export async function purgeSourceMaps(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - sourceMapRetentionMs);
  const deleted = await getDatabase()
    .delete(sourceMaps)
    .where(or(lt(sourceMaps.lastUsedAt, cutoff), and(isNull(sourceMaps.lastUsedAt), lt(sourceMaps.createdAt, cutoff))))
    .returning({ id: sourceMaps.id });
  return deleted.length;
}

