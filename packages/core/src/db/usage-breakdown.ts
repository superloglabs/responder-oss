import { and, eq, gte, sql, type AnyColumn } from "drizzle-orm";
import { getDatabase } from "./client.js";
import { agentModelUsage, automationModelUsage, sandboxUsage } from "./schema.js";

export interface UsageBreakdown {
  inferenceMicros: number;
  sandboxMicros: number;
}

// What an organization has been charged since `since`, split into model usage
// and sandbox time. Only settled charges count, by when they were settled, so
// the split matches the billing balance for the period.
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
          gte(automationModelUsage.billedAt, since),
        ),
      ),
    database
      .select({ micros: total(agentModelUsage.chargeMicros) })
      .from(agentModelUsage)
      .where(
        and(
          eq(agentModelUsage.organizationId, organizationId),
          eq(agentModelUsage.billable, true),
          gte(agentModelUsage.billedAt, since),
        ),
      ),
    database
      .select({ micros: total(sandboxUsage.chargeMicros) })
      .from(sandboxUsage)
      .where(
        and(
          eq(sandboxUsage.organizationId, organizationId),
          eq(sandboxUsage.billable, true),
          gte(sandboxUsage.billedAt, since),
        ),
      ),
  ]);
  const micros = (rows: Array<{ micros: string }>) => Number(rows[0]?.micros ?? 0);
  return {
    inferenceMicros: micros(automationInference) + micros(agentInference),
    sandboxMicros: micros(sandbox),
  };
}
