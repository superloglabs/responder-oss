import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDatabase, closeDatabase } from "./client.js";
import { organization } from "./auth-schema.js";
import { errorIssues, errorNotificationDeliveries, telemetryNotificationPauses } from "./schema.js";
import { recordErrorOccurrences, setErrorIssueStatus } from "./error-issues.js";
import { saveErrorNotificationSettings, processPendingErrorNotifications } from "./error-notifications.js";
import { groupErrorCandidates } from "../telemetry/error-issues.js";
import { defaultErrorNotificationSettings } from "../telemetry/error-notifications.js";

// Run against a disposable, migrated PostgreSQL database only.
const testUrl = process.env.TEST_ERROR_NOTIFICATION_DATABASE_URL;
describe.skipIf(!testUrl)("error notification outbox (PostgreSQL)", () => {
  const organizationId = randomUUID();
  const settings = { ...defaultErrorNotificationSettings, enabled: true, targets: [{ kind: "slack" as const, integrationAccountId: randomUUID(), channelId: "C123" }] };
  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", testUrl!);
    vi.stubEnv("DATABASE_POOL_SIZE", "1");
    await getDatabase().insert(organization).values({ id: organizationId, name: "Notification test", slug: organizationId, createdAt: new Date() });
    await saveErrorNotificationSettings(organizationId, settings);
  });
  afterAll(async () => {
    await getDatabase().delete(organization).where(eq(organization.id, organizationId));
    await closeDatabase(); vi.unstubAllEnvs();
  });
  function occurrences(message: string) {
    return groupErrorCandidates([{
      attrs: {}, resource_attrs: {}, body: "", candidate_id: randomUUID(), discovered_ms: String(Date.now()),
      exception_message: message, exception_stacktrace: "", exception_type: `TestError_${message}`, kind: "log", project_id: organizationId,
      seen_ms: String(Date.now() + 1000), service: "api", severity: "ERROR", span_id: "", span_name: "", trace_id: "",
    }])[0]!;
  }
  async function deliveries(issueId: string) {
    return getDatabase().select().from(errorNotificationDeliveries).where(eq(errorNotificationDeliveries.issueId, issueId));
  }
  it("commits each transition with its delivery and rolls both back on failure", async () => {
    const occurrence = occurrences("rollback");
    await expect(getDatabase().transaction(async (tx) => {
      await recordErrorOccurrences(tx, occurrence); throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await getDatabase().select().from(errorIssues).where(eq(errorIssues.fingerprint, occurrence.fingerprint))).toHaveLength(0);
    expect(await getDatabase().select().from(errorNotificationDeliveries).where(eq(errorNotificationDeliveries.organizationId, organizationId))).toHaveLength(0);
  });
  it("queues once for a new error, stays quiet while open, and queues again after resolution", async () => {
    const occurrence = occurrences("recurrence");
    const first = await getDatabase().transaction((tx) => recordErrorOccurrences(tx, occurrence));
    expect(first.transition).toBe("new");
    await getDatabase().transaction((tx) => recordErrorOccurrences(tx, occurrence));
    expect(await deliveries(first.issueId)).toHaveLength(1);
    await setErrorIssueStatus(organizationId, first.issueId, "resolved");
    const regression = await getDatabase().transaction((tx) => recordErrorOccurrences(tx, occurrences("recurrence")));
    expect(regression.transition).toBe("regressed");
    expect(await deliveries(first.issueId)).toHaveLength(2);
    await setErrorIssueStatus(organizationId, first.issueId, "silenced");
    await getDatabase().transaction((tx) => recordErrorOccurrences(tx, occurrences("recurrence")));
    expect(await deliveries(first.issueId)).toHaveLength(2);
  });
  it("never queues events while workspace notifications are paused", async () => {
    await getDatabase().insert(telemetryNotificationPauses).values({ organizationId });
    const first = await getDatabase().transaction((tx) => recordErrorOccurrences(tx, occurrences("paused")));
    expect(await deliveries(first.issueId)).toHaveLength(0);
    await getDatabase().delete(telemetryNotificationPauses).where(eq(telemetryNotificationPauses.organizationId, organizationId));
  });
  it("retries failed deliveries, recovers expired leases, and sends each row once across workers", async () => {
    await saveErrorNotificationSettings(organizationId, settings);
    const first = await getDatabase().transaction((tx) => recordErrorOccurrences(tx, occurrences("retry")));
    const fail = vi.fn(async () => { throw new Error("provider down"); });
    await processPendingErrorNotifications(fail);
    expect((await deliveries(first.issueId))[0]).toMatchObject({ attempts: 1, status: "pending" });
    await getDatabase().update(errorNotificationDeliveries).set({ status: "sending", nextAttemptAt: new Date(0) }).where(eq(errorNotificationDeliveries.issueId, first.issueId));
    const send = vi.fn(async () => true);
    await Promise.all([processPendingErrorNotifications(send), processPendingErrorNotifications(send)]);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await deliveries(first.issueId))[0]).toMatchObject({ attempts: 2, status: "sent" });
    await processPendingErrorNotifications(send);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("cancels queued deliveries on configuration changes", async () => {
    const first = await getDatabase().transaction((tx) => recordErrorOccurrences(tx, occurrences("cancel")));
    await saveErrorNotificationSettings(organizationId, { ...settings, enabled: false });
    expect((await deliveries(first.issueId))[0]).toMatchObject({ status: "cancelled" });
  });
});
