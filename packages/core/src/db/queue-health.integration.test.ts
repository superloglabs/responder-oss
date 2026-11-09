import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  automationRunGroupConcurrency,
  automationRunJobOptions,
  automationRunQueue,
} from "../jobs.js";
import { organization } from "./auth-schema.js";
import { closeDatabase, getDatabase } from "./client.js";
import { readQueueHealth } from "./queue-health.js";
import { automationRuns, automations, automationVersions } from "./schema.js";

// Run against a disposable, migrated PostgreSQL database only.
const testUrl = process.env.TEST_QUEUE_HEALTH_DATABASE_URL;
describe.skipIf(!testUrl)("queue health (PostgreSQL)", () => {
  const busy = randomUUID();
  const quiet = randomUUID();
  let boss: PgBoss;

  async function addRuns(organizationId: string, runs: Array<{ minutesAgo: number; status: "pending" | "running" }>) {
    const [automation] = await getDatabase().insert(automations)
      .values({ name: "Triage alerts", organizationId })
      .returning({ id: automations.id });
    const [version] = await getDatabase().insert(automationVersions).values({
      automationId: automation!.id,
      harness: "claude_agent_sdk",
      maxModelRequests: 100,
      maxOutputTokensPerRequest: 4_096,
      maxRuntimeSeconds: 600,
      model: "claude-sonnet-5-5",
      modelProvider: "anthropic",
      prompt: "Triage",
      triggers: [],
      version: 1,
    }).returning({ id: automationVersions.id });
    const now = Date.now();
    await getDatabase().insert(automationRuns).values(runs.map((run) => ({
      automationId: automation!.id,
      automationVersionId: version!.id,
      createdAt: new Date(now - run.minutesAgo * 60_000),
      leaseExpiresAt: run.status === "running" ? new Date(now + 60_000) : null,
      organizationId,
      redactedTrigger: {},
      status: run.status,
      triggerInput: {},
    })));
  }

  // Makes `count` of the workspace's run jobs active, as the worker does when
  // it takes them.
  async function activateJobs(organizationId: string, count: number) {
    for (let index = 0; index < count; index += 1) {
      await boss.send(automationRunQueue, { runId: randomUUID() }, automationRunJobOptions(organizationId));
    }
    return boss.fetch(automationRunQueue, { batchSize: count, groupConcurrency: automationRunGroupConcurrency });
  }

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", testUrl!);
    vi.stubEnv("DATABASE_POOL_SIZE", "2");
    boss = new PgBoss({ connectionString: testUrl!, max: 2 });
    await boss.start();
    await boss.createQueue(automationRunQueue);
    await getDatabase().insert(organization).values([busy, quiet].map((id) => ({
      createdAt: new Date(), id, name: "Queue health test", slug: id,
    })));
  });
  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await getDatabase().delete(organization).where(inArray(organization.id, [busy, quiet]));
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  it("leaves runs held by their own workspace's limit out of the oldest pending age", async () => {
    // One workspace's burst: its limit of runs is active and two more wait.
    await addRuns(busy, [
      ...Array.from({ length: automationRunGroupConcurrency }, () => ({ minutesAgo: 31, status: "running" as const })),
      { minutesAgo: 30, status: "pending" },
      { minutesAgo: 29, status: "pending" },
    ]);
    const active = await activateJobs(busy, automationRunGroupConcurrency);
    expect(active).toHaveLength(automationRunGroupConcurrency);
    // Another workspace's run waits for a worker slot.
    await addRuns(quiet, [{ minutesAgo: 2, status: "pending" }]);

    const held = (await readQueueHealth()).automationRuns;
    expect(held).toMatchObject({ pending: 3, workspaceLimited: 2 });
    expect(held.oldestPendingSeconds).toBeGreaterThanOrEqual(120);
    expect(held.oldestPendingSeconds).toBeLessThan(180);

    // Once one of its runs finishes, the burst's runs wait for a worker like
    // any other run and count again.
    await boss.complete(automationRunQueue, active[0]!.id);
    const freed = (await readQueueHealth()).automationRuns;
    expect(freed).toMatchObject({ pending: 3, workspaceLimited: 0 });
    expect(freed.oldestPendingSeconds).toBeGreaterThanOrEqual(1_800);
  });
});
