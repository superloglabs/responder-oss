import { and, eq, gt, gte, inArray, lt } from "drizzle-orm";
import { getDatabase } from "../db/client.js";
import {
  agentModelUsage,
  automationModelUsage,
  billingNotificationDeliveries,
  organizationCapabilities,
  sandboxUsage,
} from "../db/schema.js";
import {
  automationMinimumBalanceDollars,
  billingIsEnabled,
  getAutomationBillingSummary,
  minimumMachineHours,
  type AutomationBillingSummary,
} from "./autumn.js";
import {
  BILLING_NOTICE_RETRY_AFTER_MS,
  BILLING_NOTICE_RETRY_WINDOW_MS,
  notifyBillingLimitReached,
} from "./notifications.js";

// When a balance that stops work is used up, the reset time of that balance.
// A balance whose plan bills usage past it does not stop work and is not
// reported.
export function usageLimitReached(
  summary: AutomationBillingSummary,
): { nextResetAt: number | null } | null {
  if (!summary.configured) return null;
  if (!summary.creditOverageAllowed && summary.remaining < automationMinimumBalanceDollars) {
    return { nextResetAt: summary.nextResetAt };
  }
  const machineHours = summary.machineHours;
  if (
    machineHours &&
    !machineHours.overageAllowed &&
    machineHours.remaining < minimumMachineHours
  ) {
    return { nextResetAt: machineHours.nextResetAt };
  }
  return null;
}

// Organizations whose billable usage was reported to billing since `since`,
// and usage-billed organizations with a failed or abandoned notice that may
// still be retried. The second group keeps such a notice from being lost when
// no further usage is billed. Organizations on investigation credits are left
// to their next blocked investigation, which retries with the credit wording.
export async function organizationsToCheckForUsageNotices(since: Date): Promise<string[]> {
  const db = getDatabase();
  const retryAfter = new Date(Date.now() - BILLING_NOTICE_RETRY_WINDOW_MS);
  const staleBefore = new Date(Date.now() - BILLING_NOTICE_RETRY_AFTER_MS);
  const [models, sandboxes, agents, failedNotices] = await Promise.all([
    db
      .selectDistinct({ organizationId: automationModelUsage.organizationId })
      .from(automationModelUsage)
      .where(
        and(
          gte(automationModelUsage.billedAt, since),
          eq(automationModelUsage.inferenceSource, "responder"),
        ),
      ),
    db
      .selectDistinct({ organizationId: sandboxUsage.organizationId })
      .from(sandboxUsage)
      .where(and(gte(sandboxUsage.billedAt, since), eq(sandboxUsage.billable, true))),
    db
      .selectDistinct({ organizationId: agentModelUsage.organizationId })
      .from(agentModelUsage)
      .where(and(gte(agentModelUsage.billedAt, since), eq(agentModelUsage.billable, true))),
    db
      .selectDistinct({ organizationId: billingNotificationDeliveries.organizationId })
      .from(billingNotificationDeliveries)
      .innerJoin(
        organizationCapabilities,
        and(
          eq(organizationCapabilities.organizationId, billingNotificationDeliveries.organizationId),
          eq(organizationCapabilities.capability, "simplified_navigation"),
          eq(organizationCapabilities.enabled, true),
        ),
      )
      .where(
        and(
          inArray(billingNotificationDeliveries.status, ["failed", "pending"]),
          gt(billingNotificationDeliveries.createdAt, retryAfter),
          lt(billingNotificationDeliveries.updatedAt, staleBefore),
        ),
      ),
  ]);
  return [
    ...new Set(
      [...models, ...sandboxes, ...agents, ...failedNotices].map((row) => row.organizationId),
    ),
  ];
}

interface UsageNoticeDependencies {
  getSummary: (organizationId: string) => Promise<AutomationBillingSummary>;
  listOrganizations: (since: Date) => Promise<string[]>;
  notify: typeof notifyBillingLimitReached;
}

const defaultDependencies: UsageNoticeDependencies = {
  getSummary: (organizationId) => getAutomationBillingSummary(organizationId),
  listOrganizations: organizationsToCheckForUsageNotices,
  notify: notifyBillingLimitReached,
};

// Reads the balances of every organization whose usage was billed since
// `since`, plus `retry`, and tells those that ran out. Organizations whose
// check failed are returned so the caller can pass them back as `retry`.
// Each destination receives the notice once per period, so checking an
// organization again is harmless.
export async function sendUsageNotices(
  since: Date,
  retry: string[] = [],
  dependencies: UsageNoticeDependencies = defaultDependencies,
): Promise<{ checked: number; failedOrganizationIds: string[]; notified: number }> {
  const result = { checked: 0, failedOrganizationIds: [] as string[], notified: 0 };
  if (!billingIsEnabled()) return result;
  const organizationIds = new Set([...(await dependencies.listOrganizations(since)), ...retry]);
  for (const organizationId of organizationIds) {
    result.checked += 1;
    try {
      const limit = usageLimitReached(await dependencies.getSummary(organizationId));
      if (!limit) continue;
      await dependencies.notify(organizationId, limit.nextResetAt, { usageBased: true });
      result.notified += 1;
    } catch (error) {
      result.failedOrganizationIds.push(organizationId);
      console.error(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        event: "usage_notice_failed",
        organizationId,
      }));
    }
  }
  return result;
}
