import { and, asc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { getDatabase } from "./client.js";
import { agentModelUsage, type AgentModelUsageWorkload } from "./schema.js";

export interface AgentModelUsageRecord {
  billable: boolean;
  cachedInputTokens: number;
  chargeMicros: number | null;
  id: string;
  inputTokens: number;
  model: string;
  organizationId: string;
  outputTokens: number;
  requests: number;
  workload: AgentModelUsageWorkload;
  workloadId: string;
}

const usageSelection = {
  billable: agentModelUsage.billable,
  cachedInputTokens: agentModelUsage.cachedInputTokens,
  chargeMicros: agentModelUsage.chargeMicros,
  id: agentModelUsage.id,
  inputTokens: agentModelUsage.inputTokens,
  model: agentModelUsage.model,
  organizationId: agentModelUsage.organizationId,
  outputTokens: agentModelUsage.outputTokens,
  requests: agentModelUsage.requests,
  workload: agentModelUsage.workload,
  workloadId: agentModelUsage.workloadId,
};

export async function insertAgentModelUsage(
  input: Omit<AgentModelUsageRecord, "id">,
): Promise<AgentModelUsageRecord> {
  const rows = await getDatabase()
    .insert(agentModelUsage)
    .values(input)
    .returning(usageSelection);
  const row = rows[0];
  if (!row) throw new Error("Unable to record agent model usage");
  return row;
}

export async function setAgentModelUsageCharge(id: string, chargeMicros: number): Promise<void> {
  await getDatabase()
    .update(agentModelUsage)
    .set({ chargeMicros })
    .where(and(eq(agentModelUsage.id, id), isNull(agentModelUsage.chargeMicros)));
}

export async function markAgentModelUsageBilled(id: string): Promise<void> {
  await getDatabase()
    .update(agentModelUsage)
    .set({ billedAt: new Date() })
    .where(and(eq(agentModelUsage.id, id), isNull(agentModelUsage.billedAt)));
}

// Rows not yet settled. Never-attempted rows come first so rows that keep
// failing cannot starve newer ones.
export async function listUnbilledAgentModelUsage(input: {
  createdAfter: Date;
  createdBefore: Date;
  limit: number;
}): Promise<AgentModelUsageRecord[]> {
  return getDatabase()
    .select(usageSelection)
    .from(agentModelUsage)
    .where(
      and(
        isNull(agentModelUsage.billedAt),
        gt(agentModelUsage.createdAt, input.createdAfter),
        lt(agentModelUsage.createdAt, input.createdBefore),
      ),
    )
    .orderBy(
      sql`${agentModelUsage.billingAttemptedAt} asc nulls first`,
      asc(agentModelUsage.createdAt),
    )
    .limit(input.limit);
}

export async function markAgentModelUsageBillingAttempted(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await getDatabase()
    .update(agentModelUsage)
    .set({ billingAttemptedAt: new Date() })
    .where(inArray(agentModelUsage.id, ids));
}
