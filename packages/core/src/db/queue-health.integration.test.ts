import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createJobBoss } from "../jobs.js";
import { organization } from "./auth-schema.js";
import { closeDatabase, getDatabase } from "./client.js";
import { readQueueHealth } from "./queue-health.js";
import { type AutomationRunStatus, automationRuns, automations, automationVersions } from "./schema.js";

// Run against a disposable, migrated PostgreSQL database only. The counts
// cover every workspace, so the database must hold no other runs.
const testUrl = process.env.TEST_QUEUE_HEALTH_DATABASE_URL;
describe.skipIf(!testUrl)("queue health (PostgreSQL)", () => {
  const organizationId = randomUUID();
  let automationId: string;
  let automationVersionId: string;

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", testUrl!);
    vi.stubEnv("DATABASE_POOL_SIZE", "4");
    // The health query reads pg-boss jobs, and pg-boss creates its schema on
    // start.
    const boss = createJobBoss();
    await boss.start();
    await boss.stop({ graceful: false });
    const database = getDatabase();
    await database.insert(organization).values({
      createdAt: new Date(),
      id: organizationId,
      name: "Queue health test",
      slug: organizationId,
    });
    [{ id: automationId }] = await database
      .insert(automations)
      .values({ name: "Queue health", organizationId })
      .returning({ id: automations.id });
    [{ id: automationVersionId }] = await database
      .insert(automationVersions)
      .values({
        automationId,
        harness: "codex",
        maxModelRequests: 10,
        maxOutputTokensPerRequest: 1000,
        maxRuntimeSeconds: 600,
        model: "gpt-5.4",
        modelProvider: "openai",
        prompt: "Check the queue.",
        triggers: [],
        version: 1,
      })
      .returning({ id: automationVersions.id });
  });
  beforeEach(async () => {
    await getDatabase().delete(automationRuns).where(eq(automationRuns.organizationId, organizationId));
  });
  afterAll(async () => {
    await getDatabase().delete(organization).where(eq(organization.id, organizationId));
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  const finishedRun = (
    status: AutomationRunStatus,
    failureCategory: string | null,
    completedAt = new Date(),
  ) => ({
    automationId,
    automationVersionId,
    completedAt,
    failureCategory,
    organizationId,
    redactedTrigger: {},
    status,
    triggerInput: {},
  });

  it("counts refusals the organization caused apart from failed runs", async () => {
    await getDatabase().insert(automationRuns).values([
      finishedRun("succeeded", null),
      finishedRun("failed", "execution_failed"),
      finishedRun("failed", "execution_failed"),
      finishedRun("failed", "runtime_limit_exceeded"),
      finishedRun("failed", "usage_limit_reached"),
      finishedRun("failed", "subscription_refused"),
      finishedRun("failed", "subscription_refused"),
      finishedRun("cancelled", null),
      // Finished before the window.
      finishedRun("failed", "execution_failed", new Date(Date.now() - 20 * 60_000)),
    ]);

    expect((await readQueueHealth()).automationRuns.finished).toEqual({
      cancelled: 1,
      failed: 3,
      subscription_refused: 2,
      succeeded: 1,
      usage_limit_reached: 1,
    });
  });
});
