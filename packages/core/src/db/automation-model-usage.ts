import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type {
  AutomationInferenceSource,
  AutomationModelProvider,
} from "../automations/config.js";
import type { AutomationModelUsage } from "../automations/model-usage.js";
import { getDatabase } from "./client.js";
import { automationModelUsage } from "./schema.js";

export interface AutomationModelUsageRecord extends AutomationModelUsage {
  costMicros: number | null;
  id: string;
  inferenceSource: AutomationInferenceSource;
  model: string;
  organizationId: string;
  provider: AutomationModelProvider;
  runId: string;
}

const usageSelection = {
  cacheWriteTokens: automationModelUsage.cacheWriteTokens,
  cachedInputTokens: automationModelUsage.cachedInputTokens,
  costMicros: automationModelUsage.costMicros,
  id: automationModelUsage.id,
  inferenceSource: automationModelUsage.inferenceSource,
  inputTokens: automationModelUsage.inputTokens,
  model: automationModelUsage.model,
  organizationId: automationModelUsage.organizationId,
  outputTokens: automationModelUsage.outputTokens,
  provider: automationModelUsage.provider,
  runId: automationModelUsage.runId,
};

// A pending reservation stops counting after this long. It covers the broker's
// ten-minute provider timeout plus time to record usage.
const reservationLifetimeMs = 15 * 60_000;

export async function recordAutomationModelUsage(
  input: Omit<AutomationModelUsageRecord, "id"> & { settled: boolean },
): Promise<AutomationModelUsageRecord> {
  const { settled, ...values } = input;
  const now = new Date();
  const rows = await getDatabase()
    .insert(automationModelUsage)
    .values({ ...values, billedAt: settled ? now : null, completedAt: now })
    .returning(usageSelection);
  const row = rows[0];
  if (!row) throw new Error("Unable to record automation model usage");
  return row;
}

export async function setAutomationModelUsageCost(
  id: string,
  costMicros: number,
): Promise<void> {
  await getDatabase()
    .update(automationModelUsage)
    .set({ costMicros })
    .where(and(eq(automationModelUsage.id, id), isNull(automationModelUsage.costMicros)));
}

export async function markAutomationModelUsageBilled(id: string): Promise<void> {
  await getDatabase()
    .update(automationModelUsage)
    .set({ billedAt: new Date() })
    .where(and(eq(automationModelUsage.id, id), isNull(automationModelUsage.billedAt)));
}

// Completed rows that still need billing (Responder-funded) or pricing (any
// source). Never-attempted rows come first so rows that keep failing cannot
// starve newer ones.
export async function listUnbilledAutomationModelUsage(input: {
  createdAfter: Date;
  createdBefore: Date;
  limit: number;
}): Promise<AutomationModelUsageRecord[]> {
  return getDatabase()
    .select(usageSelection)
    .from(automationModelUsage)
    .where(
      and(
        isNull(automationModelUsage.billedAt),
        isNotNull(automationModelUsage.completedAt),
        or(
          eq(automationModelUsage.inferenceSource, "responder"),
          isNull(automationModelUsage.costMicros),
        ),
        gt(automationModelUsage.createdAt, input.createdAfter),
        lt(automationModelUsage.createdAt, input.createdBefore),
      ),
    )
    .orderBy(
      sql`${automationModelUsage.billingAttemptedAt} asc nulls first`,
      asc(automationModelUsage.createdAt),
    )
    .limit(input.limit);
}

export async function markAutomationModelUsageBillingAttempted(
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await getDatabase()
    .update(automationModelUsage)
    .set({ billingAttemptedAt: new Date() })
    .where(inArray(automationModelUsage.id, ids));
}

// Reserves the estimated maximum cost of one Responder-funded request. The
// per-organization lock makes concurrent requests see each other's
// reservations, and `isAllowed` must confirm that the billing balance covers
// every unbilled reservation plus this one.
export async function reserveResponderModelUsage(
  input: {
    estimateMicros: number;
    model: string;
    organizationId: string;
    provider: AutomationModelProvider;
    runId: string;
  },
  isAllowed: (requiredMicros: number) => Promise<boolean>,
  now = new Date(),
): Promise<string | null> {
  return getDatabase().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`automation-inference:${input.organizationId}`}, 0))`,
    );
    const outstanding = await tx
      .select({
        costMicros: sql<string>`coalesce(sum(${automationModelUsage.costMicros}), 0)`,
      })
      .from(automationModelUsage)
      .where(
        and(
          eq(automationModelUsage.organizationId, input.organizationId),
          eq(automationModelUsage.inferenceSource, "responder"),
          isNull(automationModelUsage.billedAt),
          or(
            isNotNull(automationModelUsage.completedAt),
            gt(
              automationModelUsage.createdAt,
              new Date(now.getTime() - reservationLifetimeMs),
            ),
          ),
        ),
      );
    const required = Number(outstanding[0]?.costMicros ?? 0) + input.estimateMicros;
    if (!(await isAllowed(required))) return null;
    const rows = await tx
      .insert(automationModelUsage)
      .values({
        costMicros: input.estimateMicros,
        inferenceSource: "responder",
        model: input.model,
        organizationId: input.organizationId,
        provider: input.provider,
        runId: input.runId,
      })
      .returning({ id: automationModelUsage.id });
    const row = rows[0];
    if (!row) throw new Error("Unable to reserve automation model usage");
    return row.id;
  });
}

export async function completeResponderModelUsage(
  id: string,
  usage: AutomationModelUsage,
  costMicros: number | null,
): Promise<AutomationModelUsageRecord | null> {
  const rows = await getDatabase()
    .update(automationModelUsage)
    .set({ ...usage, completedAt: new Date(), costMicros })
    .where(and(eq(automationModelUsage.id, id), isNull(automationModelUsage.completedAt)))
    .returning(usageSelection);
  return rows[0] ?? null;
}

export async function releaseResponderModelUsage(id: string): Promise<void> {
  await getDatabase()
    .delete(automationModelUsage)
    .where(and(eq(automationModelUsage.id, id), isNull(automationModelUsage.completedAt)));
}

// Removes reservations whose request never reported back, for example after a
// control-plane restart.
export async function purgeAbandonedResponderModelUsage(now = new Date()): Promise<number> {
  const rows = await getDatabase()
    .delete(automationModelUsage)
    .where(
      and(
        isNull(automationModelUsage.completedAt),
        lt(automationModelUsage.createdAt, new Date(now.getTime() - reservationLifetimeMs)),
      ),
    )
    .returning({ id: automationModelUsage.id });
  return rows.length;
}
