import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { ClaudeRoutineFireError } from "../claude-routines.js";
import { groupErrorCandidates } from "../telemetry/error-issues.js";
import { organization, user } from "./auth-schema.js";
import { closeDatabase, getDatabase } from "./client.js";
import { createClaudeRoutine, deleteClaudeRoutine, listClaudeRoutines, startClaudeRoutine } from "./claude-routines.js";
import { recordErrorOccurrences } from "./error-issues.js";
import { processPendingErrorNotifications, saveErrorNotificationSettings } from "./error-notifications.js";
import { claudeRoutines, errorNotificationDeliveries } from "./schema.js";
import {
  claimTelemetryAlertEpisodeRoutine,
  createTelemetryAlert,
  findTelemetryAlert,
  findTelemetryAlertActivation,
  finishTelemetryAlertEpisodeRoutine,
  openTelemetryAlertEpisode,
} from "./telemetry-alerts.js";

// Run against a disposable, migrated PostgreSQL database only.
const testUrl = process.env.TEST_CLAUDE_ROUTINES_DATABASE_URL;
describe.skipIf(!testUrl)("Claude routines (PostgreSQL)", () => {
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const userId = randomUUID();
  const routineInput = { createdBy: userId, name: "Triage", token: "sk-ant-oat01-secret", triggerId: "trig_01ABC" };

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", testUrl!);
    vi.stubEnv("DATABASE_POOL_SIZE", "1");
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    await getDatabase().insert(organization).values([
      { id: organizationId, name: "Routine test", slug: organizationId, createdAt: new Date() },
      { id: otherOrganizationId, name: "Other", slug: otherOrganizationId, createdAt: new Date() },
    ]);
    await getDatabase().insert(user).values({ id: userId, name: "Ash", email: `${userId}@example.com` });
  });
  afterAll(async () => {
    await getDatabase().delete(organization).where(eq(organization.id, organizationId));
    await getDatabase().delete(organization).where(eq(organization.id, otherOrganizationId));
    await getDatabase().delete(user).where(eq(user.id, userId));
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  it("stores the token encrypted and starts the routine only for its workspace", async () => {
    const routine = await createClaudeRoutine(organizationId, routineInput);
    const [row] = await getDatabase().select().from(claudeRoutines).where(eq(claudeRoutines.id, routine.id));
    expect(row!.encryptedToken).not.toContain("sk-ant-oat01-secret");
    expect(JSON.stringify(await listClaudeRoutines(organizationId))).not.toContain("secret");

    const fire = vi.fn(async () => ({ sessionUrl: "https://claude.ai/code/session_01" }));
    expect(await startClaudeRoutine({ organizationId: otherOrganizationId, routineId: routine.id, text: "x" }, { fire })).toBeNull();
    expect(await startClaudeRoutine({ organizationId, routineId: routine.id, text: "Alert" }, { fire })).toEqual({
      sessionUrl: "https://claude.ai/code/session_01",
    });
    expect(fire).toHaveBeenCalledOnce();
    expect(fire).toHaveBeenCalledWith({ text: "Alert", token: "sk-ant-oat01-secret", triggerId: "trig_01ABC" });

    const refused = vi.fn(async () => {
      throw new ClaudeRoutineFireError("The routine token was rejected", false);
    });
    await expect(startClaudeRoutine({ organizationId, routineId: routine.id, text: "Alert" }, { fire: refused })).rejects.toThrow();
    const [listed] = await listClaudeRoutines(organizationId);
    expect(listed).toMatchObject({ lastError: "The routine token was rejected", lastFiredAt: expect.any(String) });
    await deleteClaudeRoutine(organizationId, routine.id);
  });

  it("starts an alert's routine once per episode and clears the alert when the routine is removed", async () => {
    const routine = await createClaudeRoutine(organizationId, routineInput);
    const created = await createTelemetryAlert(organizationId, {
      aggregation: "count", claudeRoutineId: routine.id, comparator: "gt", createdBy: userId, description: null, enabled: true,
      evaluationIntervalSeconds: 60, field: null, filter: {}, groupBy: null, groupMode: "single", metricName: null,
      name: "Errors", slack: null, source: "logs", threshold: 1, windowMinutes: 5,
    });
    expect(created.claudeRoutineId).toBe(routine.id);
    const episode = await openTelemetryAlertEpisode({
      alertId: created.id, groupKey: "", ruleUpdatedAt: created.updatedAt, slack: null, value: 5,
    });
    expect(episode).toMatchObject({ claudeRoutineStartedAt: null });

    expect(await claimTelemetryAlertEpisodeRoutine(episode!.id)).toBe(true);
    expect(await claimTelemetryAlertEpisodeRoutine(episode!.id)).toBe(false);
    await finishTelemetryAlertEpisodeRoutine(episode!.id, null);
    expect(await claimTelemetryAlertEpisodeRoutine(episode!.id)).toBe(true);
    await finishTelemetryAlertEpisodeRoutine(episode!.id, { sessionUrl: "https://claude.ai/code/session_02" });

    const activation = await findTelemetryAlertActivation(created.id, episode!.id);
    expect(activation).toMatchObject({
      claudeRoutineSessionUrl: "https://claude.ai/code/session_02",
      claudeRoutineStartedAt: expect.any(String),
      ruleSnapshot: { claudeRoutineId: routine.id },
    });

    await deleteClaudeRoutine(organizationId, routine.id);
    expect((await findTelemetryAlert(organizationId, created.id))?.claudeRoutineId).toBeNull();
  });

  it("does not retry an error notification whose routine may have started", async () => {
    const routine = await createClaudeRoutine(organizationId, routineInput);
    await saveErrorNotificationSettings(organizationId, {
      enabled: true, targets: [{ kind: "claude_routine", routineId: routine.id }],
    });
    const [occurrence] = groupErrorCandidates([{
      attrs: {}, resource_attrs: {}, body: "", candidate_id: randomUUID(), discovered_ms: String(Date.now()),
      exception_message: "boom", exception_type: "RoutineError", exception_stacktrace: "", kind: "log", project_id: organizationId,
      seen_ms: String(Date.now() + 1000), service: "api", severity: "ERROR", span_id: "", span_name: "", trace_id: "",
    }]);
    const recorded = await getDatabase().transaction((tx) => recordErrorOccurrences(tx, occurrence!));
    const deliveries = () => getDatabase().select().from(errorNotificationDeliveries).where(eq(errorNotificationDeliveries.issueId, recorded.issueId));
    expect((await deliveries())[0]).toMatchObject({ targetKey: `claude_routine:${routine.id}`, target: { kind: "claude_routine", routineId: routine.id } });

    await processPendingErrorNotifications(async () => {
      throw new ClaudeRoutineFireError("The routine's hourly limit was reached", true);
    });
    expect((await deliveries())[0]).toMatchObject({ attempts: 1, status: "pending" });

    await getDatabase().update(errorNotificationDeliveries).set({ nextAttemptAt: new Date(0) }).where(eq(errorNotificationDeliveries.issueId, recorded.issueId));
    await processPendingErrorNotifications(async () => {
      throw new ClaudeRoutineFireError("Anthropic did not answer in time", false);
    });
    expect((await deliveries())[0]).toMatchObject({ attempts: 2, status: "failed" });
  });
});
