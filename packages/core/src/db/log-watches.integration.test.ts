import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { organization, user } from "./auth-schema.js";
import { closeDatabase, getDatabase } from "./client.js";
import {
  advanceLogWatch,
  claimDueLogWatches,
  createLogWatch,
  endLogWatch,
  LogWatchLimitError,
  maximumLogWatchesPerWorkspace,
} from "./log-watches.js";
import { logWatches } from "./schema.js";

// Run against a disposable, migrated PostgreSQL database only.
const testUrl = process.env.TEST_LOG_WATCH_DATABASE_URL;
describe.skipIf(!testUrl)("log watches (PostgreSQL)", () => {
  const organizationId = randomUUID();
  const userId = randomUUID();
  const start = new Date("2026-11-08T12:00:00.000Z");
  const at = (seconds: number) => new Date(start.getTime() + seconds * 1_000);

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", testUrl!);
    vi.stubEnv("DATABASE_POOL_SIZE", "2");
    await getDatabase().insert(organization).values({ createdAt: start, id: organizationId, name: "Log watch test", slug: organizationId });
    await getDatabase().insert(user).values({
      createdAt: start, email: `${userId}@example.com`, emailVerified: true, id: userId, name: "Watcher", updatedAt: start,
    });
  });
  afterAll(async () => {
    await getDatabase().delete(organization).where(eq(organization.id, organizationId));
    await getDatabase().delete(user).where(eq(user.id, userId));
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  const create = (now = start, minutes = 60) =>
    createLogWatch({ filters: { severity: "ERROR" }, minutes, now, organizationId, userId });

  it("waits one interval before the first check, then claims each due watch once", async () => {
    const watch = await create();
    expect(watch).toMatchObject({ checkedThrough: start, expiresAt: at(3_600), nextCheckAt: at(30) });

    expect(await claimDueLogWatches(10, at(10))).toEqual([]);
    const [first, second] = await Promise.all([claimDueLogWatches(10, at(30)), claimDueLogWatches(10, at(30))]);
    expect([...first!, ...second!].map((row) => row.id)).toEqual([watch.id]);
    expect([...first!, ...second!][0]!.nextCheckAt).toEqual(at(60));

    await advanceLogWatch({ checkedThrough: at(0), id: watch.id, subscribersCheckedAt: at(30) });
    await endLogWatch(watch.id, "unsubscribed", at(31));
    expect(await claimDueLogWatches(10, at(120))).toEqual([]);
  });

  it("ends expired watches and limits how many a workspace runs at once", async () => {
    await getDatabase().delete(logWatches).where(eq(logWatches.organizationId, organizationId));
    const short = await create(start, 5);
    await Promise.all(Array.from({ length: maximumLogWatchesPerWorkspace - 1 }, () => create()));
    await expect(create()).rejects.toBeInstanceOf(LogWatchLimitError);

    await claimDueLogWatches(10, at(301));
    const [ended] = await getDatabase().select().from(logWatches).where(eq(logWatches.id, short.id));
    expect(ended).toMatchObject({ endReason: "expired", endedAt: at(301) });
    await expect(create(at(301))).resolves.toBeDefined();
  });
});
