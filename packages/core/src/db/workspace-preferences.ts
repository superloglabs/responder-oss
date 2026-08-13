import { and, eq } from "drizzle-orm";
import { member, user } from "./auth-schema.js";
import { getDatabase } from "./client.js";

export async function rememberedOrganizationId(
  userId: string,
): Promise<string | null> {
  const database = getDatabase();
  const remembered = await database
    .select({ organizationId: user.lastOrganizationId })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const organizationId = remembered[0]?.organizationId;
  if (!organizationId) return null;

  const membership = await database
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.userId, userId),
        eq(member.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (membership[0]) return organizationId;

  await database
    .update(user)
    .set({ lastOrganizationId: null })
    .where(eq(user.id, userId));
  return null;
}

export async function rememberOrganization(
  userId: string,
  organizationId: string | null,
): Promise<void> {
  await getDatabase()
    .update(user)
    .set({ lastOrganizationId: organizationId })
    .where(eq(user.id, userId));
}
