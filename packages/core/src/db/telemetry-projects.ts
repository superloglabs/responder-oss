import { and, asc, eq } from "drizzle-orm";
import { getDatabase } from "./client.js";
import { telemetryProjects } from "./schema.js";

export type TelemetryProject = {
  name: string;
  projectId: string;
};

export async function listTelemetryProjects(
  organizationId: string,
): Promise<TelemetryProject[]> {
  return getDatabase()
    .select({
      name: telemetryProjects.name,
      projectId: telemetryProjects.projectId,
    })
    .from(telemetryProjects)
    .where(eq(telemetryProjects.organizationId, organizationId))
    .orderBy(asc(telemetryProjects.name), asc(telemetryProjects.projectId));
}

// Every telemetry read goes through this check, so a workspace can only query
// the projects linked to it.
export async function findTelemetryProject(
  organizationId: string,
  projectId: string,
): Promise<TelemetryProject | null> {
  const rows = await getDatabase()
    .select({
      name: telemetryProjects.name,
      projectId: telemetryProjects.projectId,
    })
    .from(telemetryProjects)
    .where(
      and(
        eq(telemetryProjects.organizationId, organizationId),
        eq(telemetryProjects.projectId, projectId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
