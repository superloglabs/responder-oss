import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "./client.js";
import { integrationAccounts } from "./schema.js";

// A provider tenant, as named in a webhook: an external account of a provider,
// or one of this cell's integration accounts by ID.
export const webhookTenantSchema = z.discriminatedUnion("provider", [
  z.object({
    key: z.string().min(1).max(256),
    provider: z.enum(["discord", "github", "linear", "sentry", "slack"]),
  }),
  z.object({ key: z.uuid(), provider: z.literal("integration_account") }),
]);

export type WebhookTenant = z.infer<typeof webhookTenantSchema>;

// Whether this cell has an integration account for the tenant. A
// disconnected account still counts, so its events reach the cell that
// already ignores them.
export async function hasWebhookTenant(tenant: WebhookTenant): Promise<boolean> {
  const condition =
    tenant.provider === "integration_account"
      ? eq(integrationAccounts.id, tenant.key)
      : and(
          eq(integrationAccounts.provider, tenant.provider),
          eq(integrationAccounts.externalAccountId, tenant.key),
        );
  const rows = await getDatabase()
    .select({ id: integrationAccounts.id })
    .from(integrationAccounts)
    .where(condition)
    .limit(1);
  return rows.length > 0;
}
