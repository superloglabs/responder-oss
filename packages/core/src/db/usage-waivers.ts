import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { getDatabase } from "./client.js";
import {
  agentModelUsage,
  automationModelUsage,
  automationRuns,
  sandboxUsage,
  type SandboxUsageBalance,
} from "./schema.js";

// Waived usage is settled as usual, so a charge reported before or during the
// waiver is never lost. The credit pass then returns each reported charge.

export type WaivedUsageKind = "agent_model" | "automation_model" | "sandbox";

export interface UncreditedUsage {
  // The balance the charge was reported to, or null when none was reported.
  balance: SandboxUsageBalance | null;
  chargeMicros: number | null;
  // Sandbox time, for a charge to machine hours.
  hours: number;
  id: string;
  kind: WaivedUsageKind;
  organizationId: string;
  properties: Record<string, string>;
}

// The database's current time. Usage times come from the database clock, so
// a waiver's start time must too.
export async function usageClockNow(): Promise<Date> {
  const result = await getDatabase().execute<{ now: Date | string }>(sql`select now() as now`);
  const now = result.rows[0]?.now;
  if (now === undefined) throw new Error("The database did not return its time");
  return new Date(now);
}

// Waives the Responder-funded requests and sandbox time an automation run
// used since `since`, while the caller still holds the run's lease, so a
// worker that lost the run cannot waive the turn that replaced it. Returns
// whether the lease was held.
export async function waiveAutomationRunUsage(input: {
  leaseId: string;
  runId: string;
  since: Date;
}): Promise<boolean> {
  return getDatabase().transaction(async (tx) => {
    const runs = await tx
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .where(and(eq(automationRuns.id, input.runId), eq(automationRuns.leaseId, input.leaseId)))
      .for("update");
    if (runs.length === 0) return false;
    await tx
      .update(automationModelUsage)
      .set({ waivedAt: sql`now()` })
      .where(and(
        eq(automationModelUsage.runId, input.runId),
        eq(automationModelUsage.inferenceSource, "responder"),
        gte(automationModelUsage.createdAt, input.since),
        isNull(automationModelUsage.waivedAt),
      ));
    await tx
      .update(sandboxUsage)
      .set({ waivedAt: sql`now()` })
      .where(and(
        eq(sandboxUsage.workload, "automation"),
        eq(sandboxUsage.workloadId, input.runId),
        eq(sandboxUsage.billable, true),
        gte(sandboxUsage.startedAt, input.since),
        isNull(sandboxUsage.waivedAt),
      ));
    return true;
  });
}

// Waives the billable model usage and sandbox time an investigation or pull
// request job used since `since`, including a sandbox period still open.
export async function waiveJobUsage(input: {
  since: Date;
  workload: "investigation" | "remediation";
  workloadId: string;
}): Promise<void> {
  await getDatabase().transaction(async (tx) => {
    if (input.workload === "investigation") {
      await tx
        .update(agentModelUsage)
        .set({ waivedAt: sql`now()` })
        .where(and(
          eq(agentModelUsage.workload, "investigation"),
          eq(agentModelUsage.workloadId, input.workloadId),
          eq(agentModelUsage.billable, true),
          gte(agentModelUsage.createdAt, input.since),
          isNull(agentModelUsage.waivedAt),
        ));
    }
    await tx
      .update(sandboxUsage)
      .set({ waivedAt: sql`now()` })
      .where(and(
        eq(sandboxUsage.workload, input.workload),
        eq(sandboxUsage.workloadId, input.workloadId),
        eq(sandboxUsage.billable, true),
        gte(sandboxUsage.startedAt, input.since),
        isNull(sandboxUsage.waivedAt),
      ));
  });
}

// Waived usage that was settled and not yet credited, waived after
// `waivedAfter`. Never-attempted rows come first so rows that keep failing
// cannot starve newer ones.
export async function listUncreditedUsage(input: {
  limit: number;
  waivedAfter: Date;
}): Promise<UncreditedUsage[]> {
  const database = getDatabase();
  const [automationRows, agentRows, sandboxRows] = await Promise.all([
    database
      .select({
        chargeMicros: automationModelUsage.costMicros,
        id: automationModelUsage.id,
        model: automationModelUsage.model,
        organizationId: automationModelUsage.organizationId,
        runId: automationModelUsage.runId,
      })
      .from(automationModelUsage)
      .where(and(
        eq(automationModelUsage.inferenceSource, "responder"),
        isNotNull(automationModelUsage.billedAt),
        isNull(automationModelUsage.creditedAt),
        gt(automationModelUsage.waivedAt, input.waivedAfter),
      ))
      .orderBy(
        sql`${automationModelUsage.creditAttemptedAt} asc nulls first`,
        asc(automationModelUsage.waivedAt),
      )
      .limit(input.limit),
    database
      .select({
        chargeMicros: agentModelUsage.chargeMicros,
        id: agentModelUsage.id,
        model: agentModelUsage.model,
        organizationId: agentModelUsage.organizationId,
        workload: agentModelUsage.workload,
        workloadId: agentModelUsage.workloadId,
      })
      .from(agentModelUsage)
      .where(and(
        eq(agentModelUsage.billable, true),
        isNotNull(agentModelUsage.billedAt),
        isNull(agentModelUsage.creditedAt),
        gt(agentModelUsage.waivedAt, input.waivedAfter),
      ))
      .orderBy(
        sql`${agentModelUsage.creditAttemptedAt} asc nulls first`,
        asc(agentModelUsage.waivedAt),
      )
      .limit(input.limit),
    database
      .select({
        balance: sandboxUsage.billedBalance,
        chargeMicros: sandboxUsage.chargeMicros,
        id: sandboxUsage.id,
        organizationId: sandboxUsage.organizationId,
        seconds: sql<string>`extract(epoch from ${sandboxUsage.stoppedAt} - ${sandboxUsage.startedAt})`,
        workload: sandboxUsage.workload,
        workloadId: sandboxUsage.workloadId,
      })
      .from(sandboxUsage)
      .where(and(
        isNotNull(sandboxUsage.billedAt),
        isNull(sandboxUsage.creditedAt),
        gt(sandboxUsage.waivedAt, input.waivedAfter),
      ))
      .orderBy(
        sql`${sandboxUsage.creditAttemptedAt} asc nulls first`,
        asc(sandboxUsage.waivedAt),
      )
      .limit(input.limit),
  ]);
  return [
    ...automationRows.map((row): UncreditedUsage => ({
      balance: "usage_credit",
      chargeMicros: row.chargeMicros,
      hours: 0,
      id: row.id,
      kind: "automation_model",
      organizationId: row.organizationId,
      properties: { model: row.model, runId: row.runId },
    })),
    ...agentRows.map((row): UncreditedUsage => ({
      balance: "usage_credit",
      chargeMicros: row.chargeMicros,
      hours: 0,
      id: row.id,
      kind: "agent_model",
      organizationId: row.organizationId,
      properties: {
        kind: "inference",
        model: row.model,
        workload: row.workload,
        workloadId: row.workloadId,
      },
    })),
    ...sandboxRows.map((row): UncreditedUsage => ({
      balance: row.balance,
      chargeMicros: row.chargeMicros,
      hours: Math.max(0, Number(row.seconds)) / 3_600,
      id: row.id,
      kind: "sandbox",
      organizationId: row.organizationId,
      properties: { kind: "sandbox", workload: row.workload, workloadId: row.workloadId },
    })),
  ];
}

const usageTables = {
  agent_model: agentModelUsage,
  automation_model: automationModelUsage,
  sandbox: sandboxUsage,
} as const;

export async function markUsageCredited(kind: WaivedUsageKind, id: string): Promise<void> {
  const table = usageTables[kind];
  await getDatabase()
    .update(table)
    .set({ creditedAt: sql`now()` })
    .where(and(eq(table.id, id), isNull(table.creditedAt)));
}

export async function markUsageCreditAttempted(
  usage: Array<{ id: string; kind: WaivedUsageKind }>,
): Promise<void> {
  await Promise.all((Object.keys(usageTables) as WaivedUsageKind[]).map(async (kind) => {
    const ids = usage.filter((row) => row.kind === kind).map((row) => row.id);
    if (ids.length === 0) return;
    const table = usageTables[kind];
    await getDatabase()
      .update(table)
      .set({ creditAttemptedAt: sql`now()` })
      .where(inArray(table.id, ids));
  }));
}
