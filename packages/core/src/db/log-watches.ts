import { and, count, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getDatabase } from "./client.js";
import { logWatches, type LogWatchFilters } from "./schema.js";

export type { LogWatchFilters };

export type LogWatch = typeof logWatches.$inferSelect;

// Watches a workspace can run at once. Each one is a ClickHouse query every
// check interval, and the read-only store has few query slots.
export const maximumLogWatchesPerWorkspace = 5;
export const logWatchCheckIntervalMs = 30_000;
// How long a claimed watch stays with its worker: longer than a check's query
// and emit with their retries. The check sets the next check time itself.
export const logWatchClaimMs = 2 * 60_000;
// Ended watches are kept this long, then deleted with their filters.
export const endedLogWatchRetentionMs = 7 * 86_400_000;

export class LogWatchLimitError extends Error {
  constructor() {
    super(`A workspace can run at most ${maximumLogWatchesPerWorkspace} log watches at once.`);
    this.name = "LogWatchLimitError";
  }
}

function live(now: Date) {
  return and(isNull(logWatches.endedAt), gt(logWatches.expiresAt, now));
}

// Starts a watch that reads logs from `now` on. The first check waits one
// interval, so the conversation is subscribed before anything is emitted.
export async function createLogWatch(input: {
  filters: LogWatchFilters;
  minutes: number;
  now: Date;
  organizationId: string;
  userId: string;
}): Promise<LogWatch> {
  return getDatabase().transaction(async (tx) => {
    // Serializes watch creation per workspace, so the limit holds.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`log_watches:${input.organizationId}`}))`);
    const [active] = await tx
      .select({ total: count() })
      .from(logWatches)
      .where(and(eq(logWatches.organizationId, input.organizationId), live(input.now)));
    if ((active?.total ?? 0) >= maximumLogWatchesPerWorkspace) throw new LogWatchLimitError();
    const [watch] = await tx
      .insert(logWatches)
      .values({
        checkedThrough: input.now,
        createdBy: input.userId,
        expiresAt: new Date(input.now.getTime() + input.minutes * 60_000),
        filters: input.filters,
        nextCheckAt: new Date(input.now.getTime() + logWatchCheckIntervalMs),
        organizationId: input.organizationId,
      })
      .returning();
    return watch!;
  });
}

// Ends expired watches, then claims the due ones until their claim runs out,
// so another worker skips them.
export async function claimDueLogWatches(limit: number, now: Date): Promise<LogWatch[]> {
  const db = getDatabase();
  await db
    .update(logWatches)
    .set({ endReason: "expired", endedAt: now })
    .where(and(isNull(logWatches.endedAt), lte(logWatches.expiresAt, now)));
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: logWatches.id })
      .from(logWatches)
      .where(and(live(now), lte(logWatches.nextCheckAt, now)))
      .orderBy(logWatches.nextCheckAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(logWatches)
      .set({ nextCheckAt: new Date(now.getTime() + logWatchClaimMs) })
      .where(inArray(logWatches.id, due.map((row) => row.id)))
      .returning();
  });
}

// Records a check: the cursor moves from `from`, the cursor the check read
// from, to `checkedThrough`. A check whose claim ran out, and another worker
// has since moved the cursor, changes nothing, so the cursor never goes back.
export async function advanceLogWatch(input: {
  checkedThrough: Date;
  from: Date;
  id: string;
  nextCheckAt: Date;
  subscribersCheckedAt?: Date;
}): Promise<boolean> {
  const rows = await getDatabase()
    .update(logWatches)
    .set({
      checkedThrough: input.checkedThrough,
      nextCheckAt: input.nextCheckAt,
      ...(input.subscribersCheckedAt ? { subscribersCheckedAt: input.subscribersCheckedAt } : {}),
    })
    .where(and(eq(logWatches.id, input.id), eq(logWatches.checkedThrough, input.from)))
    .returning({ id: logWatches.id });
  return rows.length > 0;
}

export async function endLogWatch(id: string, reason: "expired" | "unsubscribed", now: Date): Promise<void> {
  await getDatabase()
    .update(logWatches)
    .set({ endReason: reason, endedAt: now })
    .where(and(eq(logWatches.id, id), isNull(logWatches.endedAt)));
}

// Deletes watches that ended, or expired, more than the retention ago. An
// expired watch counts even if nothing marked it ended, which happens when
// the worker doesn't check watches (Wakeshift or telemetry is off).
export async function purgeEndedLogWatches(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - endedLogWatchRetentionMs);
  const rows = await getDatabase()
    .delete(logWatches)
    .where(or(lt(logWatches.endedAt, cutoff), lt(logWatches.expiresAt, cutoff)))
    .returning({ id: logWatches.id });
  return rows.length;
}
