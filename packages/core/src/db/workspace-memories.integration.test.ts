import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceMemoriesMaxCount, type MemoryInput } from "../memories/config.js";
import { organization, user } from "./auth-schema.js";
import { closeDatabase, getDatabase } from "./client.js";
import { workspaceMemories } from "./schema.js";
import {
  getRuntimeWorkspaceMemories,
  importWorkspaceMemories,
  listWorkspaceMemories,
  patchWorkspaceMemory,
  updateWorkspaceMemory,
} from "./workspace-memories.js";

function memory(name: string, overrides: Partial<MemoryInput> = {}): MemoryInput {
  return { body: `Body of ${name}.`, description: `About ${name}`, name, type: "project", ...overrides };
}

// Run against a disposable, migrated PostgreSQL database only.
const testUrl = process.env.TEST_WORKSPACE_MEMORY_DATABASE_URL;
describe.skipIf(!testUrl)("workspace memories (PostgreSQL)", () => {
  const organizationId = randomUUID();
  const userId = randomUUID();

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", testUrl!);
    vi.stubEnv("DATABASE_POOL_SIZE", "4");
    const now = new Date();
    await getDatabase().insert(organization).values({ id: organizationId, name: "Memory test", slug: organizationId, createdAt: now });
    await getDatabase().insert(user).values({ id: userId, name: "Ash", email: `${userId}@example.com`, emailVerified: true, createdAt: now, updatedAt: now });
  });
  beforeEach(async () => {
    await getDatabase().delete(workspaceMemories).where(eq(workspaceMemories.organizationId, organizationId));
  });
  afterAll(async () => {
    await getDatabase().delete(organization).where(eq(organization.id, organizationId));
    await getDatabase().delete(user).where(eq(user.id, userId));
    await closeDatabase(); vi.unstubAllEnvs();
  });

  it("adds new names and leaves existing memories unchanged", async () => {
    await importWorkspaceMemories({ organizationId, userId, memories: [memory("regions")] });

    const result = await importWorkspaceMemories({
      organizationId,
      userId,
      memories: [memory("regions", { body: "Changed." }), memory("worker-hangs")],
    });

    expect(result.created.map((created) => created.name)).toEqual(["worker-hangs"]);
    expect(result.existing).toEqual(["regions"]);
    expect(await getRuntimeWorkspaceMemories(organizationId)).toEqual([
      memory("regions"),
      memory("worker-hangs"),
    ]);
    expect((await listWorkspaceMemories(organizationId))[0]?.updatedBy).toEqual({ id: userId, name: "Ash" });
  });

  it("keeps a workspace at the memory limit and saves nothing from an import past it", async () => {
    const names = Array.from({ length: workspaceMemoriesMaxCount - 1 }, (_, index) => `memory-${index}`);
    for (let start = 0; start < names.length; start += 50) {
      await importWorkspaceMemories({ organizationId, userId, memories: names.slice(start, start + 50).map((name) => memory(name)) });
    }
    await importWorkspaceMemories({ organizationId, userId, memories: [memory("the-last-one")] });

    await expect(importWorkspaceMemories({ organizationId, userId, memories: [memory("one-too-many"), memory("two-too-many")] }))
      .rejects.toMatchObject({ code: "limit_reached" });
    expect(await listWorkspaceMemories(organizationId)).toHaveLength(workspaceMemoriesMaxCount);
  });

  it("lets only one of two concurrent imports pass the limit", async () => {
    const names = Array.from({ length: workspaceMemoriesMaxCount - 1 }, (_, index) => `memory-${index}`);
    for (let start = 0; start < names.length; start += 50) {
      await importWorkspaceMemories({ organizationId, userId, memories: names.slice(start, start + 50).map((name) => memory(name)) });
    }

    const results = await Promise.allSettled([
      importWorkspaceMemories({ organizationId, userId, memories: [memory("first")] }),
      importWorkspaceMemories({ organizationId, userId, memories: [memory("second")] }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await listWorkspaceMemories(organizationId)).toHaveLength(workspaceMemoriesMaxCount);
  });

  it("refuses to rename a memory to a name another memory has", async () => {
    const { created } = await importWorkspaceMemories({ organizationId, userId, memories: [memory("regions"), memory("worker-hangs")] });
    const workerHangs = created.find((entry) => entry.name === "worker-hangs")!.id;

    await expect(updateWorkspaceMemory({ organizationId, memoryId: workerHangs, userId, memory: memory("regions") }))
      .rejects.toMatchObject({ code: "name_conflict" });
    await expect(patchWorkspaceMemory({ organizationId, memoryId: workerHangs, userId, changes: { name: "regions" } }))
      .rejects.toMatchObject({ code: "name_conflict" });
  });

  it("keeps both of two concurrent changes to different fields", async () => {
    const { created } = await importWorkspaceMemories({ organizationId, userId, memories: [memory("regions")] });
    const memoryId = created[0]!.id;

    await Promise.all([
      patchWorkspaceMemory({ organizationId, memoryId, userId, changes: { description: "Where each cell runs" } }),
      patchWorkspaceMemory({ organizationId, memoryId, userId, changes: { body: "EU in eu-west-3." } }),
    ]);

    expect(await getRuntimeWorkspaceMemories(organizationId)).toEqual([
      memory("regions", { body: "EU in eu-west-3.", description: "Where each cell runs" }),
    ]);
  });

  it("refuses a change that adds a credential", async () => {
    const { created } = await importWorkspaceMemories({ organizationId, userId, memories: [memory("regions")] });

    await expect(patchWorkspaceMemory({
      organizationId,
      memoryId: created[0]!.id,
      userId,
      changes: { body: "postgres://owner:hunter2@db.internal/app" },
    })).rejects.toMatchObject({ code: "credential" });
    expect(await getRuntimeWorkspaceMemories(organizationId)).toEqual([memory("regions")]);
  });

  it("does not change another workspace's memory", async () => {
    const { created } = await importWorkspaceMemories({ organizationId, userId, memories: [memory("regions")] });

    expect(await patchWorkspaceMemory({ organizationId: randomUUID(), memoryId: created[0]!.id, userId, changes: { body: "Changed." } }))
      .toBe(false);
  });
});
