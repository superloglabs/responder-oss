import { and, eq } from "drizzle-orm";
import { getDatabase } from "./client.js";
import {
  organizationCapabilities,
  type OrganizationCapability,
} from "./schema.js";

export async function organizationHasCapability(
  organizationId: string,
  capability: OrganizationCapability,
): Promise<boolean> {
  const rows = await getDatabase()
    .select({ enabled: organizationCapabilities.enabled })
    .from(organizationCapabilities)
    .where(
      and(
        eq(organizationCapabilities.organizationId, organizationId),
        eq(organizationCapabilities.capability, capability),
        eq(organizationCapabilities.enabled, true),
      ),
    )
    .limit(1);
  return rows[0]?.enabled === true;
}

export async function setOrganizationCapability(input: {
  capability: OrganizationCapability;
  enabled: boolean;
  organizationId: string;
  updatedBy: string;
}): Promise<void> {
  await getDatabase()
    .insert(organizationCapabilities)
    .values({
      capability: input.capability,
      enabled: input.enabled,
      organizationId: input.organizationId,
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      set: {
        enabled: input.enabled,
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      },
      target: [
        organizationCapabilities.organizationId,
        organizationCapabilities.capability,
      ],
    });
}

export async function listEnabledOrganizationCapabilities(
  organizationId: string,
): Promise<OrganizationCapability[]> {
  const rows = await getDatabase()
    .select({ capability: organizationCapabilities.capability })
    .from(organizationCapabilities)
    .where(
      and(
        eq(organizationCapabilities.organizationId, organizationId),
        eq(organizationCapabilities.enabled, true),
      ),
    );
  return rows.map((row) => row.capability);
}
