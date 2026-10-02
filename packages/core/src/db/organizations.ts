import { and, asc, eq, gt } from "drizzle-orm";
import { invitation, member, organization, user } from "./auth-schema.js";
import { getDatabase } from "./client.js";

export async function getOrganizationName(
  organizationId: string,
): Promise<string | null> {
  const rows = await getDatabase()
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  return rows[0]?.name ?? null;
}

export async function getOrganizationSummary(organizationId: string) {
  const rows = await getDatabase()
    .select({
      createdAt: organization.createdAt,
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
    })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  return rows[0] ?? null;
}

// Members, oldest first, and invitations that can still be accepted.
export async function listOrganizationMembers(
  organizationId: string,
  now = new Date(),
) {
  const db = getDatabase();
  const [members, invitations] = await Promise.all([
    db
      .select({
        email: user.email,
        id: member.id,
        joinedAt: member.createdAt,
        name: user.name,
        role: member.role,
        userId: user.id,
      })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, organizationId))
      .orderBy(asc(member.createdAt)),
    db
      .select({
        createdAt: invitation.createdAt,
        email: invitation.email,
        expiresAt: invitation.expiresAt,
        id: invitation.id,
        role: invitation.role,
      })
      .from(invitation)
      .where(
        and(
          eq(invitation.organizationId, organizationId),
          eq(invitation.status, "pending"),
          gt(invitation.expiresAt, now),
        ),
      )
      .orderBy(asc(invitation.createdAt)),
  ]);
  return {
    invitations: invitations.map((pending) => ({
      ...pending,
      role: pending.role ?? "member",
    })),
    members,
  };
}
