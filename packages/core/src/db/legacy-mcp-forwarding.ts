import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { member, user } from "./auth-schema.js";
import { getDatabase } from "./client.js";

export interface LegacyMcpForwardMember {
  organizationId: string;
  role: string;
  user: { email: string; id: string; name: string };
}

// The member of a workspace in this cell with a verified email, matched
// without regard to case, who is not banned. Null when the workspace is not
// here or the person is not its member.
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
      and(
        eq(member.organizationId, organizationId),
        eq(sql`lower(${user.email})`, email.trim().toLowerCase()),
        eq(user.emailVerified, true),
        or(isNull(user.banned), eq(user.banned, false), lte(user.banExpires, now)),
      ),
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
