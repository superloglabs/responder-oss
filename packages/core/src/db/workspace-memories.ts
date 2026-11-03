import { and, asc, count, eq, sql } from "drizzle-orm";
import {
  memoryCredentialKinds,
  workspaceMemoriesMaxCount,
  type MemoryInput,
  type MemoryType,
} from "../memories/config.js";
import { user } from "./auth-schema.js";
import { getDatabase } from "./client.js";
import { workspaceMemories } from "./schema.js";

type MemoryTransaction = Parameters<
  Parameters<ReturnType<typeof getDatabase>["transaction"]>[0]
>[0];

export class WorkspaceMemoryError extends Error {
  constructor(
    message: string,
    public readonly code: "credential" | "limit_reached" | "name_conflict",
  ) {
    super(message);
    this.name = "WorkspaceMemoryError";
  }
}

export interface WorkspaceMemorySummary {
  id: string;
  name: string;
  description: string;
  type: MemoryType;
  updatedAt: Date;
  // The member who last saved the memory.
  updatedBy: { id: string; name: string } | null;
}

export interface WorkspaceMemoryDetail extends WorkspaceMemorySummary {
  body: string;
}

export interface RuntimeWorkspaceMemory {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

export interface WorkspaceMemoryImport {
  created: Array<{ id: string; name: string }>;
  // Names already in the workspace. Change those with an update.
  existing: string[];
}

// Drizzle wraps the Postgres error, so the violation is on its cause.
function isMemoryNameConflict(error: unknown): boolean {
  for (let current = error; current; current = (current as { cause?: unknown }).cause) {
    if (typeof current !== "object") break;
    if (
      "code" in current &&
      current.code === "23505" &&
      "constraint" in current &&
      current.constraint === "workspace_memories_organization_name_idx"
    ) {
      return true;
    }
  }
  return false;
}

// Memories are workspace-wide and every run reads them, so a credential in
// one would reach every sandbox.
function assertNoCredentials(memories: MemoryInput[]): void {
  const flagged = memories.flatMap((memory) => {
    const kinds = memoryCredentialKinds(memory);
    return kinds.length > 0 ? [`${memory.name} (${kinds.join(", ")})`] : [];
  });
  if (flagged.length > 0) {
    throw new WorkspaceMemoryError(
      `These memories look like they contain credentials: ${flagged.join("; ")}. Remove the values and say where they are kept instead.`,
      "credential",
    );
  }
}

const summaryColumns = {
  id: workspaceMemories.id,
  name: workspaceMemories.name,
  description: workspaceMemories.description,
  type: workspaceMemories.type,
  updatedAt: workspaceMemories.updatedAt,
  updatedById: user.id,
  updatedByName: user.name,
};

function summary<T extends { updatedById: string | null; updatedByName: string | null }>(
  { updatedById, updatedByName, ...memory }: T,
) {
  return {
    ...memory,
    updatedBy: updatedById && updatedByName ? { id: updatedById, name: updatedByName } : null,
  };
}

export async function listWorkspaceMemories(
  organizationId: string,
): Promise<WorkspaceMemorySummary[]> {
  const rows = await getDatabase()
    .select(summaryColumns)
    .from(workspaceMemories)
    .leftJoin(user, eq(user.id, workspaceMemories.updatedBy))
    .where(eq(workspaceMemories.organizationId, organizationId))
    .orderBy(asc(workspaceMemories.name));
  return rows.map(summary);
}

export async function getWorkspaceMemory(
  organizationId: string,
  memoryId: string,
): Promise<WorkspaceMemoryDetail | null> {
  const rows = await getDatabase()
    .select({ ...summaryColumns, body: workspaceMemories.body })
    .from(workspaceMemories)
    .leftJoin(user, eq(user.id, workspaceMemories.updatedBy))
    .where(
      and(
        eq(workspaceMemories.id, memoryId),
        eq(workspaceMemories.organizationId, organizationId),
      ),
    )
    .limit(1);
  return rows[0] ? summary(rows[0]) : null;
}

// Imports run one at a time per workspace, so two cannot both pass the limit.
async function lockWorkspaceMemories(tx: MemoryTransaction, organizationId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-memories:${organizationId}`}, 0))`,
  );
}

// Adds the memories whose names are new to the workspace and leaves the ones
// that exist as they are.
export async function importWorkspaceMemories(input: {
  organizationId: string;
  userId: string;
  memories: MemoryInput[];
}): Promise<WorkspaceMemoryImport> {
  assertNoCredentials(input.memories);
  return getDatabase().transaction(async (tx) => {
    await lockWorkspaceMemories(tx, input.organizationId);
    const created = input.memories.length === 0
      ? []
      : await tx
          .insert(workspaceMemories)
          .values(input.memories.map((memory) => ({
            organizationId: input.organizationId,
            createdBy: input.userId,
            updatedBy: input.userId,
            name: memory.name,
            description: memory.description,
            type: memory.type,
            body: memory.body,
          })))
          .onConflictDoNothing({
            target: [workspaceMemories.organizationId, workspaceMemories.name],
          })
          .returning({ id: workspaceMemories.id, name: workspaceMemories.name });
    const [total] = await tx
      .select({ value: count() })
      .from(workspaceMemories)
      .where(eq(workspaceMemories.organizationId, input.organizationId));
    if ((total?.value ?? 0) > workspaceMemoriesMaxCount) {
      throw new WorkspaceMemoryError(
        `A workspace can keep at most ${workspaceMemoriesMaxCount} memories. Delete or combine some first.`,
        "limit_reached",
      );
    }
    const createdNames = new Set(created.map((memory) => memory.name));
    return {
      created,
      existing: input.memories
        .map((memory) => memory.name)
        .filter((name) => !createdNames.has(name)),
    };
  });
}

// Replaces the memory's name, description, type, and body.
export async function updateWorkspaceMemory(input: {
  organizationId: string;
  memoryId: string;
  userId: string;
  memory: MemoryInput;
}): Promise<boolean> {
  assertNoCredentials([input.memory]);
  try {
    const rows = await getDatabase()
      .update(workspaceMemories)
      .set({
        name: input.memory.name,
        description: input.memory.description,
        type: input.memory.type,
        body: input.memory.body,
        updatedAt: new Date(),
        updatedBy: input.userId,
      })
      .where(
        and(
          eq(workspaceMemories.id, input.memoryId),
          eq(workspaceMemories.organizationId, input.organizationId),
        ),
      )
      .returning({ id: workspaceMemories.id });
    return Boolean(rows[0]);
  } catch (error) {
    if (isMemoryNameConflict(error)) {
      throw new WorkspaceMemoryError(
        `A memory named ${input.memory.name} already exists in this workspace`,
        "name_conflict",
      );
    }
    throw error;
  }
}

export async function deleteWorkspaceMemory(input: {
  organizationId: string;
  memoryId: string;
}): Promise<boolean> {
  const rows = await getDatabase()
    .delete(workspaceMemories)
    .where(
      and(
        eq(workspaceMemories.id, input.memoryId),
        eq(workspaceMemories.organizationId, input.organizationId),
      ),
    )
    .returning({ id: workspaceMemories.id });
  return Boolean(rows[0]);
}

// The memories a run in the workspace reads.
export async function getRuntimeWorkspaceMemories(
  organizationId: string,
): Promise<RuntimeWorkspaceMemory[]> {
  return getDatabase()
    .select({
      name: workspaceMemories.name,
      description: workspaceMemories.description,
      type: workspaceMemories.type,
      body: workspaceMemories.body,
    })
    .from(workspaceMemories)
    .where(eq(workspaceMemories.organizationId, organizationId))
    .orderBy(asc(workspaceMemories.name));
}
