import { and, eq, inArray } from "drizzle-orm";
import { getDatabase } from "./client.js";
import {
  organizationCapabilities,
  organizationCapabilityValues,
  type OrganizationCapability,
} from "./schema.js";

// Operators choose the capabilities every new organization starts with, as a
// comma-separated list. Unknown names are ignored.
export function newOrganizationCapabilities(
  configured: string | undefined,
): OrganizationCapability[] {
  const known = new Set<string>(organizationCapabilityValues);
  const names = (configured ?? "").split(",").map((name) => name.trim());
  return [...new Set(names)].filter((name): name is OrganizationCapability =>
    known.has(name)
  );
}

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

// A workspace stores and reads telemetry in Superlog when it has the
// telemetry product or Signal, which reads the same data on its own. The
// telemetry product's screens, dashboards, alerts, and error notifications
// still need `telemetry` itself.
export const telemetryDataCapabilities = [
  "telemetry",
  "signal",
] as const satisfies readonly OrganizationCapability[];

export async function organizationReceivesTelemetry(
  organizationId: string,
): Promise<boolean> {
  const rows = await getDatabase()
    .select({ enabled: organizationCapabilities.enabled })
    .from(organizationCapabilities)
    .where(
      and(
        eq(organizationCapabilities.organizationId, organizationId),
        inArray(organizationCapabilities.capability, [...telemetryDataCapabilities]),
        eq(organizationCapabilities.enabled, true),
      ),
    )
    .limit(1);
  return rows[0]?.enabled === true;
}

type Database = ReturnType<typeof getDatabase>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

// Every workspace that receives telemetry, such as for grouping errors into
// issues, and which of them have Signal without the telemetry product.
export async function listTelemetryOrganizations(
  executor: Database | Transaction = getDatabase(),
): Promise<{ organizationIds: string[]; signalOnly: Set<string> }> {
  const rows = await executor
    .select({
      capability: organizationCapabilities.capability,
      organizationId: organizationCapabilities.organizationId,
    })
    .from(organizationCapabilities)
    .where(
      and(
        inArray(organizationCapabilities.capability, [...telemetryDataCapabilities]),
        eq(organizationCapabilities.enabled, true),
      ),
    );
  const product = new Set(
    rows.filter((row) => row.capability === "telemetry").map((row) => row.organizationId),
  );
  const organizationIds = [...new Set(rows.map((row) => row.organizationId))];
  return {
    organizationIds,
    signalOnly: new Set(organizationIds.filter((id) => !product.has(id))),
  };
}

export async function setOrganizationCapability(input: {
  capability: OrganizationCapability;
  enabled: boolean;
  organizationId: string;
  updatedBy: string;
}): Promise<void> {
  // The hosted private control room owns the allowlist UI and writes this
  // shared table. The public application grants capabilities only to new
  // organizations, from operator configuration, and has no route that lets
  // an organization grant itself one.
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
