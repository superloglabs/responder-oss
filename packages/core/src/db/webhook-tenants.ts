import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "./client.js";
import { automations, integrationAccounts, telemetryNotificationPauses } from "./schema.js";

// A provider tenant, as named in a webhook: an external account of a provider,
// one of this cell's integration accounts by ID, or one of its automations by
// ID.
export const webhookTenantSchema = z.discriminatedUnion("provider", [
  z.object({
    key: z.string().min(1).max(256),
    provider: z.enum(["discord", "github", "linear", "sentry", "slack"]),
  }),
  z.object({ key: z.uuid(), provider: z.literal("integration_account") }),
  z.object({ key: z.uuid(), provider: z.literal("automation") }),
]);

export type WebhookTenant = z.infer<typeof webhookTenantSchema>;

// Whether this cell has an integration account, or the automation, for the
// tenant. A disconnected account or a disabled automation still counts, so its
// events reach the cell that already ignores them.
export async function hasWebhookTenant(tenant: WebhookTenant): Promise<boolean> {
  if (tenant.provider === "automation") {
    const rows = await getDatabase()
      .select({ id: automations.id })
      .from(automations)
      .where(eq(automations.id, tenant.key))
      .limit(1);
    return rows.length > 0;
  }
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

// Whether this cell holds a provider tenant, and whether a workspace holding
// it is active: not paused while it runs beside the old product it replaces
// (ADR 0010).
export async function webhookTenantState(
  tenant: Extract<WebhookTenant, { provider: "discord" | "github" | "linear" | "sentry" | "slack" }>,
): Promise<{ active: boolean; held: boolean }> {
  const rows = await getDatabase()
    .select({ paused: telemetryNotificationPauses.organizationId })
    .from(integrationAccounts)
    .leftJoin(
      telemetryNotificationPauses,
      eq(telemetryNotificationPauses.organizationId, integrationAccounts.organizationId),
    )
    .where(and(
      eq(integrationAccounts.provider, tenant.provider),
      eq(integrationAccounts.externalAccountId, tenant.key),
    ));
  return { active: rows.some((row) => row.paused === null), held: rows.length > 0 };
}
