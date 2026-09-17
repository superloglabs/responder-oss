import { and, desc, eq, isNull } from "drizzle-orm";
import { agents, organizationIngestPauses } from "./schema.js";
import { getDatabase } from "./client.js";

export interface OrganizationIngestPause {
  organizationId: string;
  pausedAt: Date;
  pausedBy: string;
  reason: string;
}

/**
 * Returns the open pause for an organization, or null when ingest is running.
 */
export async function getOrganizationIngestPause(
  organizationId: string,
): Promise<OrganizationIngestPause | null> {
  const [record] = await getDatabase()
    .select({
      organizationId: organizationIngestPauses.organizationId,
      pausedAt: organizationIngestPauses.pausedAt,
      pausedBy: organizationIngestPauses.pausedBy,
      reason: organizationIngestPauses.reason,
    })
    .from(organizationIngestPauses)
    .where(
      and(
        eq(organizationIngestPauses.organizationId, organizationId),
        isNull(organizationIngestPauses.resumedAt),
      ),
    )
    .limit(1);
  return record ?? null;
}

export async function isOrganizationIngestPaused(
  organizationId: string,
): Promise<boolean> {
  return (await getOrganizationIngestPause(organizationId)) !== null;
}

/**
 * Pauses ingest for an organization. Pausing an already paused organization
 * keeps the original pause, so the recorded actor and reason stay the ones
 * that stopped ingest in the first place.
 */
export async function pauseOrganizationIngest(input: {
  organizationId: string;
  pausedBy: string;
  reason: string;
}): Promise<OrganizationIngestPause> {
  const reason = input.reason.trim();
  if (!reason) throw new Error("A pause reason is required");
  const pausedBy = input.pausedBy.trim();
  if (!pausedBy) throw new Error("A pause actor is required");

  await getDatabase()
    .insert(organizationIngestPauses)
    .values({ organizationId: input.organizationId, pausedBy, reason })
    .onConflictDoNothing();

  const pause = await getOrganizationIngestPause(input.organizationId);
  if (!pause) throw new Error("Unable to record the ingest pause");
  return pause;
}

/**
 * Resumes ingest. Returns false when the organization was not paused, so the
 * caller can tell a real resume apart from a no-op.
 */
export async function resumeOrganizationIngest(input: {
  organizationId: string;
  resumedBy: string;
}): Promise<boolean> {
  const resumedBy = input.resumedBy.trim();
  if (!resumedBy) throw new Error("A resume actor is required");

  const resumed = await getDatabase()
    .update(organizationIngestPauses)
    .set({ resumedAt: new Date(), resumedBy })
    .where(
      and(
        eq(organizationIngestPauses.organizationId, input.organizationId),
        isNull(organizationIngestPauses.resumedAt),
      ),
    )
    .returning({ id: organizationIngestPauses.id });
  return resumed.length > 0;
}

export interface OrganizationIngestPauseRecord extends OrganizationIngestPause {
  resumedAt: Date | null;
  resumedBy: string | null;
}

export async function listOrganizationIngestPauses(
  organizationId: string,
): Promise<OrganizationIngestPauseRecord[]> {
  return getDatabase()
    .select({
      organizationId: organizationIngestPauses.organizationId,
      pausedAt: organizationIngestPauses.pausedAt,
      pausedBy: organizationIngestPauses.pausedBy,
      reason: organizationIngestPauses.reason,
      resumedAt: organizationIngestPauses.resumedAt,
      resumedBy: organizationIngestPauses.resumedBy,
    })
    .from(organizationIngestPauses)
    .where(eq(organizationIngestPauses.organizationId, organizationId))
    .orderBy(desc(organizationIngestPauses.pausedAt));
}

/**
 * Pause lookup for the ingest path, keyed by agent so a webhook can be dropped
 * with a single indexed query before any investigation work begins.
 */
export async function getIngestPauseForAgent(
  agentId: string,
): Promise<OrganizationIngestPause | null> {
  const [record] = await getDatabase()
    .select({
      organizationId: organizationIngestPauses.organizationId,
      pausedAt: organizationIngestPauses.pausedAt,
      pausedBy: organizationIngestPauses.pausedBy,
      reason: organizationIngestPauses.reason,
    })
    .from(agents)
    .innerJoin(
      organizationIngestPauses,
      and(
        eq(organizationIngestPauses.organizationId, agents.organizationId),
        isNull(organizationIngestPauses.resumedAt),
      ),
    )
    .where(eq(agents.id, agentId))
    .limit(1);
  return record ?? null;
}
