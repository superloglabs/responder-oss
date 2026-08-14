import { and, asc, eq } from "drizzle-orm";
import { getDatabase } from "./client.js";
import {
  agentConfigVersions,
  agentVersionSecrets,
  agents,
  workspaceSecrets,
} from "./schema.js";

export interface WorkspaceSecretSummary {
  id: string;
  name: string;
  allowedHosts: string[];
  createdAt: Date;
}

export interface RuntimeWorkspaceSecret {
  environmentVariable: string;
  daytonaSecretName: string;
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
}): Promise<WorkspaceSecretSummary | null> {
  const rows = await getDatabase()
    .select({
      id: workspaceSecrets.id,
      name: workspaceSecrets.name,
      allowedHosts: workspaceSecrets.allowedHosts,
      createdAt: workspaceSecrets.createdAt,
    })
    .from(workspaceSecrets)
    .where(
      and(
        eq(workspaceSecrets.organizationId, input.organizationId),
        eq(workspaceSecrets.name, input.name),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createWorkspaceSecretRecord(input: {
  organizationId: string;
  userId: string;
  name: string;
  allowedHosts: string[];
  daytonaSecretId: string;
  daytonaSecretName: string;
}): Promise<WorkspaceSecretSummary> {
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
