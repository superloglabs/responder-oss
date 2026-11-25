import { and, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { member, user } from "./auth-schema.js";
import { getDatabase } from "./client.js";
import { legacyMcpForwardAssertions, legacyMcpForwards } from "./schema.js";

export interface LegacyMcpForwardMember {
  organizationId: string;
  role: string;
  user: { email: string; id: string; name: string };
}

// Records a forwarded assertion's ID until it expires. False when the ID was
// already accepted, so the assertion is a replay. Expired IDs are dropped
// first; an assertion is refused after it expires anyway.
export async function claimLegacyMcpForwardAssertion(
  jti: string,
  expiresAt: Date,
  now = new Date(),
): Promise<boolean> {
  const db = getDatabase();
  await db.delete(legacyMcpForwardAssertions).where(lt(legacyMcpForwardAssertions.expiresAt, now));
  const claimed = await db
    .insert(legacyMcpForwardAssertions)
    .values({ expiresAt, jti })
    .onConflictDoNothing()
    .returning({ jti: legacyMcpForwardAssertions.jti });
  return claimed.length > 0;
}

function memberConditions(email: string, now: Date) {
  return and(
    eq(sql`lower(${user.email})`, email.trim().toLowerCase()),
    eq(user.emailVerified, true),
    or(isNull(user.banned), eq(user.banned, false), lte(user.banExpires, now)),
  );
}

// The member, by verified email and not banned, of the workspace an old
// project moved to. Null when the project has no legacy_mcp_forwards row in
// this cell or the person is not a member of its workspace.
export async function findForwardedWorkspaceMember(
  legacyProjectId: string,
  email: string,
  now = new Date(),
): Promise<LegacyMcpForwardMember | null> {
  const rows = await getDatabase()
    .select({
      email: user.email,
      name: user.name,
      organizationId: member.organizationId,
      role: member.role,
      userId: user.id,
    })
    .from(legacyMcpForwards)
    .innerJoin(member, eq(member.organizationId, legacyMcpForwards.organizationId))
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(legacyMcpForwards.legacyProjectId, legacyProjectId), memberConditions(email, now)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    organizationId: row.organizationId,
    role: row.role,
    user: { email: row.email, id: row.userId, name: row.name },
  };
}

// For the earlier shared credential: the member of any workspace in this
// cell with a verified email, matched without regard to case, who is not
// banned. Null when the workspace is not here or the person is not its
// member.
export async function findLegacyMcpForwardMember(
  organizationId: string,
  email: string,
  now = new Date(),
): Promise<LegacyMcpForwardMember | null> {
  const rows = await getDatabase()
    .select({
      email: user.email,
      name: user.name,
      organizationId: member.organizationId,
      role: member.role,
      userId: user.id,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(eq(member.organizationId, organizationId), memberConditions(email, now)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    organizationId: row.organizationId,
    role: row.role,
    user: { email: row.email, id: row.userId, name: row.name },
  };
}
