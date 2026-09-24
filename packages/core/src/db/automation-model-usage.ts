import { and, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
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

export async function recordAutomationModelUsage(
  input: Omit<AutomationModelUsageRecord, "id"> & { settled: boolean },
): Promise<AutomationModelUsageRecord> {
  const { settled, ...values } = input;
  const rows = await getDatabase()
    .insert(automationModelUsage)
    .values({ ...values, billedAt: settled ? new Date() : null })
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
        eq(automationModelUsage.inferenceSource, "responder"),
        isNull(automationModelUsage.billedAt),
        gt(automationModelUsage.createdAt, input.createdAfter),
        lt(automationModelUsage.createdAt, input.createdBefore),
      ),
    )
    // Rows that failed recently go to the back, so a few rows that keep
    // failing cannot starve newer ones.
    .orderBy(sql`coalesce(${automationModelUsage.billingAttemptedAt}, ${automationModelUsage.createdAt})`)
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
