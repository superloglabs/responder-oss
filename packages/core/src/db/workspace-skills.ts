import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { SkillFile, SkillInput } from "../skills/config.js";
import { getDatabase } from "./client.js";
import {
  automations,
  automationVersions,
  automationVersionSkills,
  workspaceSecrets,
  workspaceSkillFiles,
  workspaceSkills,
  workspaceSkillSecrets,
} from "./schema.js";
import type { RuntimeWorkspaceSecret } from "./workspace-secrets.js";

type SkillTransaction = Parameters<
  Parameters<ReturnType<typeof getDatabase>["transaction"]>[0]
>[0];

export class WorkspaceSkillError extends Error {
  constructor(
    message: string,
    public readonly code: "in_use" | "name_conflict" | "secret_not_found",
  ) {
    super(message);
    this.name = "WorkspaceSkillError";
  }
}

export interface WorkspaceSkillSecret {
  id: string;
  name: string;
  allowedHosts: string[];
}

export interface WorkspaceSkillSummary {
  id: string;
  name: string;
  description: string;
  fileCount: number;
  secrets: WorkspaceSkillSecret[];
  // Automations whose active version uses the skill.
  automations: Array<{ id: string; name: string }>;
  updatedAt: Date;
}

export interface WorkspaceSkillDetail extends WorkspaceSkillSummary {
  instructions: string;
  files: SkillFile[];
}

export interface RuntimeWorkspaceSkill {
  name: string;
  description: string;
  instructions: string;
  files: SkillFile[];
  secrets: RuntimeWorkspaceSecret[];
}

// Drizzle wraps the Postgres error, so the violation is on its cause.
function isSkillNameConflict(error: unknown): boolean {
  for (let current = error; current; current = (current as { cause?: unknown }).cause) {
    if (typeof current !== "object") break;
    if (
      "code" in current &&
      current.code === "23505" &&
      "constraint" in current &&
      current.constraint === "workspace_skills_organization_name_idx"
    ) {
      return true;
    }
  }
  return false;
}

async function skillSecrets(skillIds: string[]) {
  if (skillIds.length === 0) return new Map<string, WorkspaceSkillSecret[]>();
  const rows = await getDatabase()
    .select({
      skillId: workspaceSkillSecrets.skillId,
      id: workspaceSecrets.id,
      name: workspaceSecrets.name,
      allowedHosts: workspaceSecrets.allowedHosts,
    })
    .from(workspaceSkillSecrets)
    .innerJoin(
      workspaceSecrets,
      eq(workspaceSecrets.id, workspaceSkillSecrets.workspaceSecretId),
    )
    .where(inArray(workspaceSkillSecrets.skillId, skillIds))
    .orderBy(asc(workspaceSecrets.name));
  const bySkill = new Map<string, WorkspaceSkillSecret[]>();
  for (const { skillId, ...secret } of rows) {
    bySkill.set(skillId, [...(bySkill.get(skillId) ?? []), secret]);
  }
  return bySkill;
}

async function skillAutomations(skillIds: string[]) {
  if (skillIds.length === 0) return new Map<string, Array<{ id: string; name: string }>>();
  const rows = await getDatabase()
    .select({
      skillId: automationVersionSkills.skillId,
      id: automations.id,
      name: automations.name,
    })
    .from(automationVersionSkills)
    .innerJoin(
      automations,
      eq(automations.activeVersionId, automationVersionSkills.automationVersionId),
    )
    .where(inArray(automationVersionSkills.skillId, skillIds))
    .orderBy(asc(automations.name));
  const bySkill = new Map<string, Array<{ id: string; name: string }>>();
  for (const { skillId, ...automation } of rows) {
    bySkill.set(skillId, [...(bySkill.get(skillId) ?? []), automation]);
  }
  return bySkill;
}

export async function listWorkspaceSkills(
  organizationId: string,
): Promise<WorkspaceSkillSummary[]> {
  const db = getDatabase();
  const skills = await db
    .select({
      id: workspaceSkills.id,
      name: workspaceSkills.name,
      description: workspaceSkills.description,
      updatedAt: workspaceSkills.updatedAt,
      fileCount: sql<number>`(select count(*)::int from ${workspaceSkillFiles} where ${workspaceSkillFiles.skillId} = ${workspaceSkills.id})`,
    })
    .from(workspaceSkills)
    .where(eq(workspaceSkills.organizationId, organizationId))
    .orderBy(asc(workspaceSkills.name));
  const ids = skills.map((skill) => skill.id);
  const [secrets, automationsBySkill] = await Promise.all([
    skillSecrets(ids),
    skillAutomations(ids),
  ]);
  return skills.map((skill) => ({
    ...skill,
    automations: automationsBySkill.get(skill.id) ?? [],
    secrets: secrets.get(skill.id) ?? [],
  }));
}

export async function getWorkspaceSkill(
  organizationId: string,
  skillId: string,
): Promise<WorkspaceSkillDetail | null> {
  const db = getDatabase();
  const rows = await db
    .select({
      id: workspaceSkills.id,
      name: workspaceSkills.name,
      description: workspaceSkills.description,
      instructions: workspaceSkills.instructions,
      updatedAt: workspaceSkills.updatedAt,
    })
    .from(workspaceSkills)
    .where(
      and(
        eq(workspaceSkills.id, skillId),
        eq(workspaceSkills.organizationId, organizationId),
      ),
    )
    .limit(1);
  const skill = rows[0];
  if (!skill) return null;
  const [files, secrets, automationsBySkill] = await Promise.all([
    db
      .select({ path: workspaceSkillFiles.path, content: workspaceSkillFiles.content })
      .from(workspaceSkillFiles)
      .where(eq(workspaceSkillFiles.skillId, skill.id))
      .orderBy(asc(workspaceSkillFiles.path)),
    skillSecrets([skill.id]),
    skillAutomations([skill.id]),
  ]);
  return {
    ...skill,
    automations: automationsBySkill.get(skill.id) ?? [],
    fileCount: files.length,
    files,
    secrets: secrets.get(skill.id) ?? [],
  };
}

async function assertSecretsInOrganization(
  tx: SkillTransaction,
  organizationId: string,
  secretIds: string[],
): Promise<void> {
  if (secretIds.length === 0) return;
  const rows = await tx
    .select({ id: workspaceSecrets.id })
    .from(workspaceSecrets)
    .where(
      and(
        eq(workspaceSecrets.organizationId, organizationId),
        inArray(workspaceSecrets.id, secretIds),
      ),
    );
  if (rows.length !== secretIds.length) {
    throw new WorkspaceSkillError(
      "One or more selected workspace secrets are unavailable",
      "secret_not_found",
    );
  }
}

async function insertSkillContents(
  tx: SkillTransaction,
  skillId: string,
  input: SkillInput,
): Promise<void> {
  await Promise.all([
    ...(input.files.length > 0
      ? [tx.insert(workspaceSkillFiles).values(
          input.files.map((file) => ({ skillId, path: file.path, content: file.content })),
        )]
      : []),
    ...(input.secretIds.length > 0
      ? [tx.insert(workspaceSkillSecrets).values(
          input.secretIds.map((workspaceSecretId) => ({ skillId, workspaceSecretId })),
        )]
      : []),
  ]);
}

async function withNameConflict<T>(save: () => Promise<T>, name: string): Promise<T> {
  try {
    return await save();
  } catch (error) {
    if (isSkillNameConflict(error)) {
      throw new WorkspaceSkillError(
        `A skill named ${name} already exists in this workspace`,
        "name_conflict",
      );
    }
    throw error;
  }
}

export async function createWorkspaceSkill(input: {
  organizationId: string;
  userId: string;
  skill: SkillInput;
}): Promise<{ id: string }> {
  return withNameConflict(() => getDatabase().transaction(async (tx) => {
    await assertSecretsInOrganization(tx, input.organizationId, input.skill.secretIds);
    const rows = await tx
      .insert(workspaceSkills)
      .values({
        organizationId: input.organizationId,
        createdBy: input.userId,
        name: input.skill.name,
        description: input.skill.description,
        instructions: input.skill.instructions,
      })
      .returning({ id: workspaceSkills.id });
    const skillId = rows[0]?.id;
    if (!skillId) throw new Error("Unable to create workspace skill");
    await insertSkillContents(tx, skillId, input.skill);
    return { id: skillId };
  }), input.skill.name);
}

// Replaces the skill's instructions, files, and secrets.
export async function updateWorkspaceSkill(input: {
  organizationId: string;
  skillId: string;
  skill: SkillInput;
}): Promise<boolean> {
  return withNameConflict(() => getDatabase().transaction(async (tx) => {
    const rows = await tx
      .update(workspaceSkills)
      .set({
        name: input.skill.name,
        description: input.skill.description,
        instructions: input.skill.instructions,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaceSkills.id, input.skillId),
          eq(workspaceSkills.organizationId, input.organizationId),
        ),
      )
      .returning({ id: workspaceSkills.id });
    if (!rows[0]) return false;
    await assertSecretsInOrganization(tx, input.organizationId, input.skill.secretIds);
    await Promise.all([
      tx.delete(workspaceSkillFiles).where(eq(workspaceSkillFiles.skillId, input.skillId)),
      tx.delete(workspaceSkillSecrets).where(eq(workspaceSkillSecrets.skillId, input.skillId)),
    ]);
    await insertSkillContents(tx, input.skillId, input.skill);
    return true;
  }), input.skill.name);
}

// A skill an automation still uses cannot be deleted. Remove it from those
// automations first.
export async function deleteWorkspaceSkill(input: {
  organizationId: string;
  skillId: string;
}): Promise<boolean> {
  return getDatabase().transaction(async (tx) => {
    const rows = await tx
      .select({ id: workspaceSkills.id })
      .from(workspaceSkills)
      .where(
        and(
          eq(workspaceSkills.id, input.skillId),
          eq(workspaceSkills.organizationId, input.organizationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!rows[0]) return false;
    const users = await tx
      .select({ name: automations.name })
      .from(automationVersionSkills)
      .innerJoin(
        automations,
        eq(automations.activeVersionId, automationVersionSkills.automationVersionId),
      )
      .where(eq(automationVersionSkills.skillId, input.skillId))
      .orderBy(asc(automations.name));
    if (users.length > 0) {
      throw new WorkspaceSkillError(
        `Remove this skill from ${users.map((row) => row.name).join(", ")} before deleting it`,
        "in_use",
      );
    }
    await tx.delete(workspaceSkills).where(eq(workspaceSkills.id, input.skillId));
    return true;
  });
}

// The skills an automation version uses, with their files and secrets.
export async function getAutomationRuntimeSkills(
  automationVersionId: string,
): Promise<RuntimeWorkspaceSkill[]> {
  const db = getDatabase();
  const skills = await db
    .select({
      id: workspaceSkills.id,
      name: workspaceSkills.name,
      description: workspaceSkills.description,
      instructions: workspaceSkills.instructions,
    })
    .from(automationVersionSkills)
    .innerJoin(
      automationVersions,
      eq(automationVersions.id, automationVersionSkills.automationVersionId),
    )
    .innerJoin(automations, eq(automations.id, automationVersions.automationId))
    .innerJoin(
      workspaceSkills,
      and(
        eq(workspaceSkills.id, automationVersionSkills.skillId),
        eq(workspaceSkills.organizationId, automations.organizationId),
      ),
    )
    .where(eq(automationVersionSkills.automationVersionId, automationVersionId))
    .orderBy(asc(workspaceSkills.name));
  if (skills.length === 0) return [];
  const ids = skills.map((skill) => skill.id);
  const [files, secrets] = await Promise.all([
    db
      .select({
        skillId: workspaceSkillFiles.skillId,
        path: workspaceSkillFiles.path,
        content: workspaceSkillFiles.content,
      })
      .from(workspaceSkillFiles)
      .where(inArray(workspaceSkillFiles.skillId, ids))
      .orderBy(asc(workspaceSkillFiles.path)),
    db
      .select({
        skillId: workspaceSkillSecrets.skillId,
        environmentVariable: workspaceSecrets.name,
        daytonaSecretName: workspaceSecrets.daytonaSecretName,
        allowedHosts: workspaceSecrets.allowedHosts,
      })
      .from(workspaceSkillSecrets)
      .innerJoin(
        workspaceSkills,
        eq(workspaceSkills.id, workspaceSkillSecrets.skillId),
      )
      .innerJoin(
        workspaceSecrets,
        and(
          eq(workspaceSecrets.id, workspaceSkillSecrets.workspaceSecretId),
          eq(workspaceSecrets.organizationId, workspaceSkills.organizationId),
        ),
      )
      .where(inArray(workspaceSkillSecrets.skillId, ids))
      .orderBy(asc(workspaceSecrets.name)),
  ]);
  return skills.map(({ id, ...skill }) => ({
    ...skill,
    files: files
      .filter((file) => file.skillId === id)
      .map(({ path, content }) => ({ path, content })),
    secrets: secrets
      .filter((secret) => secret.skillId === id)
      .map(({ environmentVariable, daytonaSecretName, allowedHosts }) => ({
        environmentVariable,
        daytonaSecretName,
        allowedHosts,
      })),
  }));
}
