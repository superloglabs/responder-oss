import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { member, organization, user } from "./auth-schema.js";
import { getDatabase } from "./client.js";

export interface MemberWorkspace {
  name: string;
}

// At most this many workspaces are named for one address, each name cut to
// this many characters.
export const maxMemberWorkspaces = 5;
export const maxMemberWorkspaceNameLength = 200;

// The workspaces a person belongs to here, found by an exact email match
// without regard to case. Only a verified, unbanned account counts, so an
// address someone has not proven they own names no workspace.
export async function listVerifiedMemberWorkspaces(
  email: string,
  now = new Date(),
): Promise<MemberWorkspace[]> {
  const rows = await getDatabase()
    .select({ name: organization.name })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(
      and(
        eq(sql`lower(${user.email})`, email.trim().toLowerCase()),
        eq(user.emailVerified, true),
        or(isNull(user.banned), eq(user.banned, false), lte(user.banExpires, now)),
      ),
    )
    .orderBy(asc(member.createdAt))
    .limit(maxMemberWorkspaces);
  return rows.map((row) => ({ name: row.name.slice(0, maxMemberWorkspaceNameLength) }));
}
