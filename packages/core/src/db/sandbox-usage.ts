import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { getDatabase } from "./client.js";
import { sandboxUsage, type SandboxUsageWorkload } from "./schema.js";

export interface SandboxUsageRecord {
  billable: boolean;
  chargeMicros: number | null;
  cpu: number;
  diskGiB: number;
  id: string;
  memoryGiB: number;
  organizationId: string;
  startedAt: Date;
  stoppedAt: Date;
  // The run turn failed through Responder's fault, so it is not charged.
  waived: boolean;
  workload: SandboxUsageWorkload;
  workloadId: string;
}

const usageSelection = {
  billable: sandboxUsage.billable,
  chargeMicros: sandboxUsage.chargeMicros,
  cpu: sandboxUsage.cpu,
  diskGiB: sandboxUsage.diskGiB,
  id: sandboxUsage.id,
  memoryGiB: sandboxUsage.memoryGiB,
  organizationId: sandboxUsage.organizationId,
  startedAt: sandboxUsage.startedAt,
  stoppedAt: sandboxUsage.stoppedAt,
  waived: sql<boolean>`${sandboxUsage.waivedAt} is not null`,
  workload: sandboxUsage.workload,
  workloadId: sandboxUsage.workloadId,
};

function stoppedRecord(
  row: Omit<SandboxUsageRecord, "stoppedAt"> & { stoppedAt: Date | null },
): SandboxUsageRecord {
  if (!row.stoppedAt) throw new Error("Sandbox usage has not stopped");
  return { ...row, stoppedAt: row.stoppedAt };
}

// Period times come from the database clock, so workers with skewed clocks
// neither lengthen periods nor close each other's periods early.
export async function startSandboxUsage(input: {
  billable: boolean;
  cpu: number;
  diskGiB: number;
  memoryGiB: number;
  organizationId: string;
  workload: SandboxUsageWorkload;
  workloadId: string;
}): Promise<string> {
  const rows = await getDatabase()
    .insert(sandboxUsage)
    .values({ ...input, heartbeatAt: sql`now()`, startedAt: sql`now()` })
    .returning({ id: sandboxUsage.id });
  const row = rows[0];
  if (!row) throw new Error("Unable to record sandbox usage");
  return row.id;
}

export async function heartbeatSandboxUsage(id: string): Promise<void> {
  await getDatabase()
    .update(sandboxUsage)
    .set({ heartbeatAt: sql`now()` })
    .where(and(eq(sandboxUsage.id, id), isNull(sandboxUsage.stoppedAt)));
}

// Returns null when the period was already closed, for example by the stale
// period sweep after a long database outage. A waived period is not charged.
export async function stopSandboxUsage(
  id: string,
  options: { waived?: boolean } = {},
): Promise<SandboxUsageRecord | null> {
  const rows = await getDatabase()
    .update(sandboxUsage)
    .set({
      heartbeatAt: sql`now()`,
      stoppedAt: sql`now()`,
      ...(options.waived ? { waivedAt: sql`now()` } : {}),
    })
    .where(and(eq(sandboxUsage.id, id), isNull(sandboxUsage.stoppedAt)))
    .returning(usageSelection);
  return rows[0] ? stoppedRecord(rows[0]) : null;
}

// Closes periods whose worker stopped renewing them, at their last heartbeat.
export async function closeStaleSandboxUsage(staleAfterMs: number): Promise<number> {
  const rows = await getDatabase()
    .update(sandboxUsage)
    .set({ stoppedAt: sql`${sandboxUsage.heartbeatAt}` })
    .where(and(
      isNull(sandboxUsage.stoppedAt),
      lt(sandboxUsage.heartbeatAt, sql`now() - ${staleAfterMs} * interval '1 millisecond'`),
    ))
    .returning({ id: sandboxUsage.id });
  return rows.length;
}

export async function setSandboxUsageCharge(id: string, chargeMicros: number): Promise<void> {
  await getDatabase()
    .update(sandboxUsage)
    .set({ chargeMicros })
    .where(and(eq(sandboxUsage.id, id), isNull(sandboxUsage.chargeMicros)));
}

export async function markSandboxUsageBilled(id: string): Promise<void> {
  await getDatabase()
    .update(sandboxUsage)
    .set({ billedAt: new Date() })
    .where(and(eq(sandboxUsage.id, id), isNull(sandboxUsage.billedAt)));
}

// Settles a waived period without reporting it. A period another settlement
// already reported stays uncredited, so the credit pass returns its charge.
export async function markWaivedSandboxUsageSettled(id: string): Promise<void> {
  await getDatabase()
    .update(sandboxUsage)
    .set({ billedAt: sql`now()`, creditedAt: sql`now()` })
    .where(and(eq(sandboxUsage.id, id), isNull(sandboxUsage.billedAt)));
}

// Waives the billable periods a workload started since `since`, including one
// still running.
export async function waiveSandboxUsage(input: {
  since: Date;
  workload: SandboxUsageWorkload;
  workloadId: string;
}): Promise<void> {
  await getDatabase()
    .update(sandboxUsage)
    .set({ waivedAt: sql`now()` })
    .where(and(
      eq(sandboxUsage.workload, input.workload),
      eq(sandboxUsage.workloadId, input.workloadId),
      eq(sandboxUsage.billable, true),
      gte(sandboxUsage.startedAt, input.since),
      isNull(sandboxUsage.waivedAt),
    ));
}

// Waived periods that were reported to billing and not yet credited.
export async function listUncreditedSandboxUsage(input: {
  limit: number;
  waivedAfter: Date;
}): Promise<SandboxUsageRecord[]> {
  const rows = await getDatabase()
    .select(usageSelection)
    .from(sandboxUsage)
    .where(and(
      isNotNull(sandboxUsage.waivedAt),
      isNull(sandboxUsage.creditedAt),
      isNotNull(sandboxUsage.billedAt),
      gt(sandboxUsage.waivedAt, input.waivedAfter),
    ))
    .orderBy(asc(sandboxUsage.waivedAt))
    .limit(input.limit);
  return rows.map(stoppedRecord);
}

export async function markSandboxUsageCredited(id: string): Promise<void> {
  await getDatabase()
    .update(sandboxUsage)
    .set({ creditedAt: sql`now()` })
    .where(and(eq(sandboxUsage.id, id), isNull(sandboxUsage.creditedAt)));
}

// Stopped periods not yet settled. Never-attempted rows come first so rows
// that keep failing cannot starve newer ones.
export async function listUnbilledSandboxUsage(input: {
  limit: number;
  stoppedAfter: Date;
  stoppedBefore: Date;
}): Promise<SandboxUsageRecord[]> {
  const rows = await getDatabase()
    .select(usageSelection)
    .from(sandboxUsage)
    .where(
      and(
        isNull(sandboxUsage.billedAt),
        isNotNull(sandboxUsage.stoppedAt),
        gt(sandboxUsage.stoppedAt, input.stoppedAfter),
        lt(sandboxUsage.stoppedAt, input.stoppedBefore),
      ),
    )
    .orderBy(
      sql`${sandboxUsage.billingAttemptedAt} asc nulls first`,
      asc(sandboxUsage.stoppedAt),
    )
    .limit(input.limit);
  return rows.map(stoppedRecord);
}

export async function markSandboxUsageBillingAttempted(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await getDatabase()
    .update(sandboxUsage)
    .set({ billingAttemptedAt: new Date() })
    .where(inArray(sandboxUsage.id, ids));
}
