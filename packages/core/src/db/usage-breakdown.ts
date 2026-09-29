import { and, eq, gte, isNotNull, sql, type AnyColumn } from "drizzle-orm";
import { getDatabase } from "./client.js";
import { agentModelUsage, automationModelUsage, sandboxUsage } from "./schema.js";

export interface UsageBreakdown {
  inferenceMicros: number;
  sandboxMicros: number;
}

// What an organization has been charged since `since`, split into model usage
// and sandbox time. Pending model reservations and running sandboxes are not
// counted until they finish.
export async function getUsageBreakdown(
  organizationId: string,
  since: Date,
): Promise<UsageBreakdown> {
  const database = getDatabase();
  const total = (column: AnyColumn) =>
    sql<string>`coalesce(sum(${column}), 0)`;
  const [automationInference, agentInference, sandbox] = await Promise.all([
    database
      .select({ micros: total(automationModelUsage.costMicros) })
      .from(automationModelUsage)
      .where(
        and(
          eq(automationModelUsage.organizationId, organizationId),
          eq(automationModelUsage.inferenceSource, "responder"),
          isNotNull(automationModelUsage.completedAt),
          gte(automationModelUsage.createdAt, since),
        ),
      ),
    database
      .select({ micros: total(agentModelUsage.chargeMicros) })
      .from(agentModelUsage)
      .where(
        and(
          eq(agentModelUsage.organizationId, organizationId),
          eq(agentModelUsage.billable, true),
          gte(agentModelUsage.createdAt, since),
        ),
      ),
    database
      .select({ micros: total(sandboxUsage.chargeMicros) })
      .from(sandboxUsage)
      .where(
        and(
          eq(sandboxUsage.organizationId, organizationId),
          eq(sandboxUsage.billable, true),
          gte(sandboxUsage.stoppedAt, since),
        ),
      ),
  ]);
  const micros = (rows: Array<{ micros: string }>) => Number(rows[0]?.micros ?? 0);
  return {
    inferenceMicros: micros(automationInference) + micros(agentInference),
    sandboxMicros: micros(sandbox),
  };
}
