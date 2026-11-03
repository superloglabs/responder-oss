import { eq } from "drizzle-orm";
import { getDatabase } from "./client.js";
import { runBillingAccounts } from "./schema.js";

export interface RunBillingAccount {
  customerId: string;
  featureId: string;
  model: string;
  modelName: string;
  modelProvider: string;
}

// The workspace's price-per-run account, or null when it has none.
export async function getRunBillingAccount(organizationId: string): Promise<RunBillingAccount | null> {
  const rows = await getDatabase()
    .select({
      customerId: runBillingAccounts.customerId,
      featureId: runBillingAccounts.featureId,
      model: runBillingAccounts.model,
      modelName: runBillingAccounts.modelName,
      modelProvider: runBillingAccounts.modelProvider,
    })
    .from(runBillingAccounts)
    .where(eq(runBillingAccounts.organizationId, organizationId))
    .limit(1);
  return rows[0] ?? null;
}
