import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { getDatabase } from "./client.js";
import { errorNotificationDeliveries, errorNotificationSettings, errorIssues, integrationAccounts, telemetryNotificationPauses } from "./schema.js";
import {
  defaultErrorNotificationSettings, errorNotificationTargetKey, matchesErrorNotification,
  type ErrorNotificationSettings, type ErrorNotificationSnapshot,
} from "../telemetry/error-notifications.js";

type Database = ReturnType<typeof getDatabase>;
export type ErrorNotificationTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export async function getErrorNotificationSettings(organizationId: string): Promise<ErrorNotificationSettings> {
  const [row] = await getDatabase().select().from(errorNotificationSettings).where(eq(errorNotificationSettings.organizationId, organizationId));
  return row?.settings ?? defaultErrorNotificationSettings;
}
export async function saveErrorNotificationSettings(organizationId: string, settings: ErrorNotificationSettings): Promise<void> {
  const uniqueTargets = [...new Map(settings.targets.map((target) => [errorNotificationTargetKey(target), target])).values()];
  await getDatabase().transaction(async (tx) => {
    // Serialize with ingestion so an old configuration cannot enqueue after
    // its pending deliveries have been cancelled.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('error-issue-ingest', 0))`);
    await tx.insert(errorNotificationSettings).values({ organizationId, settings: { ...settings, targets: uniqueTargets } })
      .onConflictDoUpdate({ target: errorNotificationSettings.organizationId, set: { settings: { ...settings, targets: uniqueTargets }, updatedAt: new Date() } });
    await tx.update(errorNotificationDeliveries).set({ status: "cancelled" }).where(and(
      eq(errorNotificationDeliveries.organizationId, organizationId), inArray(errorNotificationDeliveries.status, ["pending", "sending"]),
    ));
  });
}
export async function enqueueErrorNotifications(tx: Database | ErrorNotificationTransaction, input: {
  organizationId: string; issueId: string; eventKey: string; snapshot: ErrorNotificationSnapshot;
}): Promise<void> {
  const [pause] = await tx.select().from(telemetryNotificationPauses).where(eq(telemetryNotificationPauses.organizationId, input.organizationId));
  if (pause) return;
  const [row] = await tx.select().from(errorNotificationSettings).where(eq(errorNotificationSettings.organizationId, input.organizationId));
  if (!row || !matchesErrorNotification(row.settings) || row.settings.targets.length === 0) return;
  await tx.insert(errorNotificationDeliveries).values(row.settings.targets.map((target) => ({
    ...input, target, targetKey: errorNotificationTargetKey(target),
  }))).onConflictDoNothing();
}

export const errorNotificationRetryLimit = 10;
export function errorNotificationRetryAt(attempt: number, now: Date): Date {
  return new Date(now.getTime() + Math.min(3_600_000, 60_000 * 2 ** (attempt - 1)));
}

// Claim briefly under a row lock, then release the database connection before
// calling providers. An interrupted worker's lease expires after five minutes.
// The attempt number prevents an expired claim from acknowledging a new claim.
export async function processPendingErrorNotifications(deliver: (delivery: typeof errorNotificationDeliveries.$inferSelect) => Promise<boolean>): Promise<void> {
  for (let pass = 0; pass < 25; pass++) {
    const delivery = await getDatabase().transaction(async (tx) => {
      const [row] = await tx.select().from(errorNotificationDeliveries).where(and(
        inArray(errorNotificationDeliveries.status, ["pending", "sending"]), lte(errorNotificationDeliveries.nextAttemptAt, new Date()),
      )).orderBy(errorNotificationDeliveries.nextAttemptAt).limit(1).for("update", { skipLocked: true });
      if (!row) return null;
      const [claimed] = await tx.update(errorNotificationDeliveries).set({ status: "sending", attempts: row.attempts + 1,
        nextAttemptAt: new Date(Date.now() + 5 * 60_000),
      }).where(eq(errorNotificationDeliveries.id, row.id)).returning();
      return claimed!;
    });
    if (!delivery) break;
    const claim = and(eq(errorNotificationDeliveries.id, delivery.id), eq(errorNotificationDeliveries.status, "sending"), eq(errorNotificationDeliveries.attempts, delivery.attempts));
    try {
      const [issue] = await getDatabase().select({ status: errorIssues.status }).from(errorIssues).where(and(
        eq(errorIssues.id, delivery.issueId), eq(errorIssues.organizationId, delivery.organizationId),
      ));
      // Stop retrying stale notifications after a bounded delivery window.
      const expired = Date.now() - delivery.createdAt.getTime() >= 23 * 3_600_000 || delivery.attempts > errorNotificationRetryLimit;
      const sent = !expired && issue?.status === "open" && await deliver(delivery);
      await getDatabase().update(errorNotificationDeliveries).set({ status: expired ? "failed" : sent ? "sent" : "cancelled", sentAt: sent ? new Date() : null }).where(claim);
    } catch {
      await getDatabase().update(errorNotificationDeliveries).set({ status: delivery.attempts >= errorNotificationRetryLimit ? "failed" : "pending", nextAttemptAt: errorNotificationRetryAt(delivery.attempts, new Date()) }).where(claim);
      console.warn(JSON.stringify({ event: "error_notification_delivery_failed", deliveryId: delivery.id, attempts: delivery.attempts }));
    }
  }
  // Keep the outbox bounded without deleting pending deliveries.
  await getDatabase().delete(errorNotificationDeliveries).where(and(inArray(errorNotificationDeliveries.status, ["sent", "failed", "cancelled"]), sql`${errorNotificationDeliveries.createdAt} < now() - interval '30 days'`));
}

// A signed Slack action is only authorized in the original delivery's team
// and channel, through a connection that still belongs to this organization.
export async function getErrorNotificationForSlackAction(input: {
  deliveryId: string; teamId: string; channelId: string;
}): Promise<{ organizationId: string; issueId: string } | null> {
  const [row] = await getDatabase().select({
    organizationId: errorNotificationDeliveries.organizationId,
    issueId: errorNotificationDeliveries.issueId,
  }).from(errorNotificationDeliveries).innerJoin(integrationAccounts, and(
    sql`${integrationAccounts.id}::text = ${errorNotificationDeliveries.target}->>'integrationAccountId'`,
    eq(integrationAccounts.organizationId, errorNotificationDeliveries.organizationId),
  )).where(and(
    eq(errorNotificationDeliveries.id, input.deliveryId),
    eq(errorNotificationDeliveries.status, "sent"),
    eq(integrationAccounts.provider, "slack"),
    eq(integrationAccounts.status, "connected"),
    eq(integrationAccounts.externalAccountId, input.teamId),
    sql`${errorNotificationDeliveries.target}->>'kind' = 'slack'`,
    sql`${errorNotificationDeliveries.target}->>'channelId' = ${input.channelId}`,
  )).limit(1);
  return row ?? null;
}
