import { getDatabase } from "./client.js";
import { telemetryNotificationPauses } from "./schema.js";

// Workspaces whose telemetry notifications are paused. Operators pause them
// from the control room.
export async function pausedTelemetryNotificationOrganizations(
  executor: Pick<ReturnType<typeof getDatabase>, "select"> = getDatabase(),
): Promise<Set<string>> {
  const rows = await executor
    .select({ organizationId: telemetryNotificationPauses.organizationId })
    .from(telemetryNotificationPauses);
  return new Set(rows.map((row) => row.organizationId));
}
