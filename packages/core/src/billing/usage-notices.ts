import { and, eq, gt, gte } from "drizzle-orm";
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
// and usage-billed organizations with a failed notice that may still be
// retried. The second group keeps a failed notice from being lost when no
// further usage is billed. Organizations on investigation credits are left to
// their next blocked investigation, which retries with the credit wording.
export async function organizationsToCheckForUsageNotices(since: Date): Promise<string[]> {
  const db = getDatabase();
  const retryAfter = new Date(Date.now() - BILLING_NOTICE_RETRY_WINDOW_MS);
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
          eq(billingNotificationDeliveries.status, "failed"),
          gt(billingNotificationDeliveries.createdAt, retryAfter),
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
// `since` and tells those that ran out. Each destination receives the notice
// once per period, so checking an organization again is harmless.
export async function sendUsageNotices(
  since: Date,
  dependencies: UsageNoticeDependencies = defaultDependencies,
): Promise<{ checked: number; failed: number; notified: number }> {
  const result = { checked: 0, failed: 0, notified: 0 };
  if (!billingIsEnabled()) return result;
  const organizationIds = await dependencies.listOrganizations(since);
  for (const organizationId of organizationIds) {
    result.checked += 1;
    try {
      const limit = usageLimitReached(await dependencies.getSummary(organizationId));
      if (!limit) continue;
      await dependencies.notify(organizationId, limit.nextResetAt, { usageBased: true });
      result.notified += 1;
    } catch (error) {
      result.failed += 1;
      console.error(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        event: "usage_notice_failed",
        organizationId,
      }));
    }
  }
  return result;
}
