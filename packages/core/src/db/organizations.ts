import { eq } from "drizzle-orm";
import { organization } from "./auth-schema.js";
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
