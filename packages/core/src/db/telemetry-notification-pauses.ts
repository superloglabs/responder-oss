import { inArray } from "drizzle-orm";
import { getDatabase } from "./client.js";
import { telemetryNotificationPauses } from "./schema.js";

// The workspaces, of those given, whose telemetry notifications are paused.
// Operators pause them from the control room.
export async function pausedTelemetryNotificationOrganizations(organizationIds: readonly string[]): Promise<Set<string>> {
  if (organizationIds.length === 0) return new Set();
  const rows = await getDatabase()
    .select({ organizationId: telemetryNotificationPauses.organizationId })
    .from(telemetryNotificationPauses)
    .where(inArray(telemetryNotificationPauses.organizationId, [...new Set(organizationIds)]));
  return new Set(rows.map((row) => row.organizationId));
}
