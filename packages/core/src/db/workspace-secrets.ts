import { and, asc, eq, isNull } from "drizzle-orm";
import { getDatabase } from "./client.js";
import {
  agentConfigVersions,
  agentVersionSecrets,
  agents,
  automations,
  automationVersions,
  automationVersionSecrets,
  workspaceSecrets,
} from "./schema.js";
import { isWorkspaceSecretEnvironmentVariableName } from "../workspace-secret-names.js";

export interface WorkspaceSecretSummary {
  id: string;
  name: string;
  allowedHosts: string[];
  createdAt: Date;
}

export interface RuntimeWorkspaceSecret {
  environmentVariable: string;
  daytonaSecretName: string | null;
  encryptedValue: string | null;
  allowedHosts: string[];
}

export async function listWorkspaceSecrets(
  organizationId: string,
): Promise<WorkspaceSecretSummary[]> {
  return getDatabase()
    .select({
      id: workspaceSecrets.id,
      name: workspaceSecrets.name,
      allowedHosts: workspaceSecrets.allowedHosts,
      createdAt: workspaceSecrets.createdAt,
    })
    .from(workspaceSecrets)
    .where(eq(workspaceSecrets.organizationId, organizationId))
    .orderBy(asc(workspaceSecrets.name));
}

export async function findWorkspaceSecretByName(input: {
  organizationId: string;
  name: string;
}): Promise<
  | (WorkspaceSecretSummary & {
    daytonaSecretId: string | null;
    daytonaSecretName: string | null;
    hasValue: boolean;
  })
  | null
> {
  const rows = await getDatabase()
    .select({
      id: workspaceSecrets.id,
      name: workspaceSecrets.name,
      allowedHosts: workspaceSecrets.allowedHosts,
      createdAt: workspaceSecrets.createdAt,
      daytonaSecretId: workspaceSecrets.daytonaSecretId,
      daytonaSecretName: workspaceSecrets.daytonaSecretName,
      encryptedValue: workspaceSecrets.encryptedValue,
    })
    .from(workspaceSecrets)
    .where(
      and(
        eq(workspaceSecrets.organizationId, input.organizationId),
        eq(workspaceSecrets.name, input.name),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const { encryptedValue, ...secret } = row;
  return { ...secret, hasValue: encryptedValue !== null };
}

// Fills in what a secret is missing: its stored value, for a secret saved
// before values were stored, or its Daytona copy, for one saved while Daytona
// was not in use. The hosts and both copies are written together. Returns
// false when another save filled it in first.
export async function storeWorkspaceSecretValue(input: {
  id: string;
  allowedHosts: string[];
  daytonaSecretId: string | null;
  daytonaSecretName: string | null;
  encryptedValue: string;
  missing: "daytonaCopy" | "value";
}): Promise<boolean> {
  if (input.allowedHosts.length === 0) {
    throw new Error("Workspace secrets require at least one allowed host");
  }
  const missing = input.missing === "value"
    ? isNull(workspaceSecrets.encryptedValue)
    : isNull(workspaceSecrets.daytonaSecretId);
  const rows = await getDatabase()
    .update(workspaceSecrets)
    .set({
      allowedHosts: input.allowedHosts,
      daytonaSecretId: input.daytonaSecretId,
      daytonaSecretName: input.daytonaSecretName,
      encryptedValue: input.encryptedValue,
    })
    .where(and(eq(workspaceSecrets.id, input.id), missing))
    .returning({ id: workspaceSecrets.id });
  return rows.length > 0;
}

export async function createWorkspaceSecretRecord(input: {
  organizationId: string;
  userId: string;
  name: string;
  allowedHosts: string[];
  daytonaSecretId: string | null;
  daytonaSecretName: string | null;
  encryptedValue: string;
}): Promise<WorkspaceSecretSummary> {
  if (!isWorkspaceSecretEnvironmentVariableName(input.name)) {
    throw new Error("Invalid workspace secret environment variable name");
  }
  if (input.allowedHosts.length === 0) {
    throw new Error("Workspace secrets require at least one allowed host");
  }
  const rows = await getDatabase()
    .insert(workspaceSecrets)
    .values({
      organizationId: input.organizationId,
      createdBy: input.userId,
      name: input.name,
      allowedHosts: input.allowedHosts,
      daytonaSecretId: input.daytonaSecretId,
      daytonaSecretName: input.daytonaSecretName,
      encryptedValue: input.encryptedValue,
    })
    .returning({
      id: workspaceSecrets.id,
      name: workspaceSecrets.name,
      allowedHosts: workspaceSecrets.allowedHosts,
      createdAt: workspaceSecrets.createdAt,
    });
  const secret = rows[0];
  if (!secret) throw new Error("Unable to save workspace secret metadata");
  return secret;
}

export async function getRuntimeWorkspaceSecrets(
  agentConfigVersionId: string,
): Promise<RuntimeWorkspaceSecret[]> {
  return getDatabase()
    .select({
      environmentVariable: workspaceSecrets.name,
      daytonaSecretName: workspaceSecrets.daytonaSecretName,
      encryptedValue: workspaceSecrets.encryptedValue,
      allowedHosts: workspaceSecrets.allowedHosts,
    })
    .from(agentVersionSecrets)
    .innerJoin(
      agentConfigVersions,
      eq(agentConfigVersions.id, agentVersionSecrets.agentConfigVersionId),
    )
    .innerJoin(agents, eq(agents.id, agentConfigVersions.agentId))
    .innerJoin(
      workspaceSecrets,
      and(
        eq(workspaceSecrets.id, agentVersionSecrets.workspaceSecretId),
        eq(workspaceSecrets.organizationId, agents.organizationId),
      ),
    )
    .where(eq(agentVersionSecrets.agentConfigVersionId, agentConfigVersionId))
    .orderBy(asc(workspaceSecrets.name));
}

export async function getAutomationRuntimeWorkspaceSecrets(
  automationVersionId: string,
): Promise<RuntimeWorkspaceSecret[]> {
  return getDatabase()
    .select({
      environmentVariable: workspaceSecrets.name,
      daytonaSecretName: workspaceSecrets.daytonaSecretName,
      encryptedValue: workspaceSecrets.encryptedValue,
      allowedHosts: workspaceSecrets.allowedHosts,
    })
    .from(automationVersionSecrets)
    .innerJoin(
      automationVersions,
      eq(automationVersions.id, automationVersionSecrets.automationVersionId),
    )
    .innerJoin(automations, eq(automations.id, automationVersions.automationId))
    .innerJoin(
      workspaceSecrets,
      and(
        eq(workspaceSecrets.id, automationVersionSecrets.workspaceSecretId),
        eq(workspaceSecrets.organizationId, automations.organizationId),
      ),
    )
    .where(eq(automationVersionSecrets.automationVersionId, automationVersionId))
    .orderBy(asc(workspaceSecrets.name));
}
