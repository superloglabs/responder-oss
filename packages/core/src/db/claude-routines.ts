import { and, asc, eq } from "drizzle-orm";
import { fireClaudeRoutine } from "../claude-routines.js";
import { decryptCredentials, encryptCredentials } from "../credentials/encryption.js";
import { getDatabase } from "./client.js";
import { claudeRoutines } from "./schema.js";

// A routine as the workspace sees it. The token is never returned.
export type ClaudeRoutine = {
  createdAt: string;
  id: string;
  lastError: string | null;
  lastFiredAt: string | null;
  name: string;
  triggerId: string;
};

const columns = {
  createdAt: claudeRoutines.createdAt,
  id: claudeRoutines.id,
  lastError: claudeRoutines.lastError,
  lastFiredAt: claudeRoutines.lastFiredAt,
  name: claudeRoutines.name,
  triggerId: claudeRoutines.triggerId,
};

function toRoutine(row: { createdAt: Date; id: string; lastError: string | null; lastFiredAt: Date | null; name: string; triggerId: string }): ClaudeRoutine {
  return { ...row, createdAt: row.createdAt.toISOString(), lastFiredAt: row.lastFiredAt?.toISOString() ?? null };
}

export async function listClaudeRoutines(organizationId: string): Promise<ClaudeRoutine[]> {
  const rows = await getDatabase()
    .select(columns)
    .from(claudeRoutines)
    .where(eq(claudeRoutines.organizationId, organizationId))
    .orderBy(asc(claudeRoutines.name), asc(claudeRoutines.id));
  return rows.map(toRoutine);
}

export async function findClaudeRoutine(organizationId: string, routineId: string): Promise<ClaudeRoutine | null> {
  const [row] = await getDatabase()
    .select(columns)
    .from(claudeRoutines)
    .where(and(eq(claudeRoutines.organizationId, organizationId), eq(claudeRoutines.id, routineId)))
    .limit(1);
  return row ? toRoutine(row) : null;
}

export async function createClaudeRoutine(
  organizationId: string,
  input: { createdBy: string; name: string; token: string; triggerId: string },
): Promise<ClaudeRoutine> {
  const [row] = await getDatabase()
    .insert(claudeRoutines)
    .values({
      createdBy: input.createdBy,
      encryptedToken: encryptCredentials({ token: input.token }),
      name: input.name,
      organizationId,
      triggerId: input.triggerId,
    })
    .returning(columns);
  return toRoutine(row!);
}

// Alerts that start the routine stop starting anything.
export async function deleteClaudeRoutine(organizationId: string, routineId: string): Promise<boolean> {
  const rows = await getDatabase()
    .delete(claudeRoutines)
    .where(and(eq(claudeRoutines.organizationId, organizationId), eq(claudeRoutines.id, routineId)))
    .returning({ id: claudeRoutines.id });
  return rows.length > 0;
}

export interface StartClaudeRoutineDependencies {
  fire: typeof fireClaudeRoutine;
}

// Starts a session of the workspace's routine with `text` as its context, and
// records the outcome on the routine. Returns null when the routine was
// removed. Throws ClaudeRoutineFireError when Anthropic refuses.
export async function startClaudeRoutine(
  input: { organizationId: string; routineId: string; text: string },
  dependencies: StartClaudeRoutineDependencies = { fire: fireClaudeRoutine },
): Promise<{ sessionUrl: string | null } | null> {
  const [row] = await getDatabase()
    .select({ encryptedToken: claudeRoutines.encryptedToken, triggerId: claudeRoutines.triggerId })
    .from(claudeRoutines)
    .where(and(eq(claudeRoutines.organizationId, input.organizationId), eq(claudeRoutines.id, input.routineId)))
    .limit(1);
  if (!row) return null;
  const { token } = decryptCredentials<{ token: string }>(row.encryptedToken);
  try {
    const started = await dependencies.fire({ text: input.text, token, triggerId: row.triggerId });
    await getDatabase()
      .update(claudeRoutines)
      .set({ lastError: null, lastFiredAt: new Date() })
      .where(eq(claudeRoutines.id, input.routineId));
    return started;
  } catch (error) {
    await getDatabase()
      .update(claudeRoutines)
      .set({ lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500) })
      .where(eq(claudeRoutines.id, input.routineId))
      .catch(() => undefined);
    throw error;
  }
}
