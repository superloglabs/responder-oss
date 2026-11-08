import { and, count, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { getDatabase } from "./client.js";
import { logWatches, type LogWatchFilters } from "./schema.js";

export type { LogWatchFilters };

export type LogWatch = typeof logWatches.$inferSelect;

// Watches a workspace can run at once. Each one is a ClickHouse query every
// check interval, and the read-only store has few query slots.
export const maximumLogWatchesPerWorkspace = 5;
export const logWatchCheckIntervalMs = 30_000;

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

// Ends expired watches, then claims the due ones and moves their next check
// one interval on, so another worker skips them.
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
      .set({ nextCheckAt: new Date(now.getTime() + logWatchCheckIntervalMs) })
      .where(inArray(logWatches.id, due.map((row) => row.id)))
      .returning();
  });
}

export async function advanceLogWatch(input: {
  checkedThrough: Date;
  id: string;
  subscribersCheckedAt?: Date;
}): Promise<void> {
  await getDatabase()
    .update(logWatches)
    .set({
      checkedThrough: input.checkedThrough,
      ...(input.subscribersCheckedAt ? { subscribersCheckedAt: input.subscribersCheckedAt } : {}),
    })
    .where(eq(logWatches.id, input.id));
}

export async function endLogWatch(id: string, reason: "expired" | "unsubscribed", now: Date): Promise<void> {
  await getDatabase()
    .update(logWatches)
    .set({ endReason: reason, endedAt: now })
    .where(and(eq(logWatches.id, id), isNull(logWatches.endedAt)));
}
