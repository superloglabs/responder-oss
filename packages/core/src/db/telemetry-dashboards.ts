import { and, asc, count, desc, eq, inArray, max, sql } from "drizzle-orm";
import type {
  DashboardVariable,
  DashboardWidgetConfig,
  DashboardWidgetLayout,
  DashboardWidgetType,
} from "../telemetry/dashboards.js";
import { getDatabase } from "./client.js";
import { telemetryDashboards, telemetryDashboardWidgets } from "./schema.js";

export type TelemetryDashboardSummary = {
  id: string;
  name: string;
  updatedAt: string;
  widgetCount: number;
};

export type TelemetryDashboardWidget = {
  config: DashboardWidgetConfig;
  id: string;
  layout: DashboardWidgetLayout;
  position: number;
  title: string;
  type: DashboardWidgetType;
};

export type TelemetryDashboard = Omit<TelemetryDashboardSummary, "widgetCount"> & {
  variables: DashboardVariable[];
  widgets: TelemetryDashboardWidget[];
};

const widgetColumns = {
  config: telemetryDashboardWidgets.config,
  id: telemetryDashboardWidgets.id,
  layout: telemetryDashboardWidgets.layout,
  position: telemetryDashboardWidgets.position,
  title: telemetryDashboardWidgets.title,
  type: telemetryDashboardWidgets.type,
};

export async function listTelemetryDashboards(organizationId: string): Promise<TelemetryDashboardSummary[]> {
  const rows = await getDatabase()
    .select({
      id: telemetryDashboards.id,
      name: telemetryDashboards.name,
      updatedAt: telemetryDashboards.updatedAt,
      widgetCount: count(telemetryDashboardWidgets.id),
    })
    .from(telemetryDashboards)
    .leftJoin(telemetryDashboardWidgets, eq(telemetryDashboardWidgets.dashboardId, telemetryDashboards.id))
    .where(eq(telemetryDashboards.organizationId, organizationId))
    .groupBy(telemetryDashboards.id)
    .orderBy(desc(telemetryDashboards.updatedAt), asc(telemetryDashboards.id));
  return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
}

async function findDashboardRow(organizationId: string, dashboardId: string) {
  const rows = await getDatabase()
    .select({
      id: telemetryDashboards.id,
      name: telemetryDashboards.name,
      updatedAt: telemetryDashboards.updatedAt,
      variables: telemetryDashboards.variables,
    })
    .from(telemetryDashboards)
    .where(and(eq(telemetryDashboards.organizationId, organizationId), eq(telemetryDashboards.id, dashboardId)))
    .limit(1);
  const row = rows[0];
  return row ? { ...row, updatedAt: row.updatedAt.toISOString() } : null;
}

export async function findTelemetryDashboard(
  organizationId: string,
  dashboardId: string,
): Promise<TelemetryDashboard | null> {
  const dashboard = await findDashboardRow(organizationId, dashboardId);
  if (!dashboard) return null;
  const widgets = await getDatabase()
    .select(widgetColumns)
    .from(telemetryDashboardWidgets)
    .where(eq(telemetryDashboardWidgets.dashboardId, dashboardId))
    .orderBy(asc(telemetryDashboardWidgets.position), asc(telemetryDashboardWidgets.createdAt));
  return { ...dashboard, widgets };
}

export async function createTelemetryDashboard(
  organizationId: string,
  input: { createdBy: string; name: string; variables?: DashboardVariable[] },
): Promise<TelemetryDashboard> {
  const [row] = await getDatabase()
    .insert(telemetryDashboards)
    .values({
      createdBy: input.createdBy,
      name: input.name,
      organizationId,
      variables: input.variables ?? [],
    })
    .returning({
      id: telemetryDashboards.id,
      name: telemetryDashboards.name,
      updatedAt: telemetryDashboards.updatedAt,
      variables: telemetryDashboards.variables,
    });
  return { ...row!, updatedAt: row!.updatedAt.toISOString(), widgets: [] };
}

export async function updateTelemetryDashboard(
  organizationId: string,
  dashboardId: string,
  update: { name?: string; variables?: DashboardVariable[] },
): Promise<TelemetryDashboard | null> {
  if (!(await findDashboardRow(organizationId, dashboardId))) return null;
  await getDatabase()
    .update(telemetryDashboards)
    .set({ ...update, updatedAt: new Date() })
    .where(and(eq(telemetryDashboards.organizationId, organizationId), eq(telemetryDashboards.id, dashboardId)));
  return findTelemetryDashboard(organizationId, dashboardId);
}

export async function deleteTelemetryDashboard(organizationId: string, dashboardId: string): Promise<boolean> {
  if (!(await findDashboardRow(organizationId, dashboardId))) return false;
  const deleted = await getDatabase()
    .delete(telemetryDashboards)
    .where(and(eq(telemetryDashboards.organizationId, organizationId), eq(telemetryDashboards.id, dashboardId)))
    .returning({ id: telemetryDashboards.id });
  return deleted.length > 0;
}

function touchDashboard(dashboardId: string) {
  return getDatabase()
    .update(telemetryDashboards)
    .set({ updatedAt: new Date() })
    .where(eq(telemetryDashboards.id, dashboardId));
}

export async function addTelemetryDashboardWidget(
  organizationId: string,
  dashboardId: string,
  widget: { config: DashboardWidgetConfig; layout: DashboardWidgetLayout; title: string; type: DashboardWidgetType },
): Promise<TelemetryDashboardWidget | null> {
  if (!(await findDashboardRow(organizationId, dashboardId))) return null;
  const [last] = await getDatabase()
    .select({ position: max(telemetryDashboardWidgets.position) })
    .from(telemetryDashboardWidgets)
    .where(eq(telemetryDashboardWidgets.dashboardId, dashboardId));
  const [created] = await getDatabase()
    .insert(telemetryDashboardWidgets)
    .values({ ...widget, dashboardId, position: (last?.position ?? -1) + 1 })
    .returning(widgetColumns);
  await touchDashboard(dashboardId);
  return created ?? null;
}

export async function updateTelemetryDashboardWidget(
  organizationId: string,
  dashboardId: string,
  widgetId: string,
  update: { config?: DashboardWidgetConfig; layout?: DashboardWidgetLayout; title?: string },
): Promise<TelemetryDashboardWidget | null> {
  if (!(await findDashboardRow(organizationId, dashboardId))) return null;
  const [updated] = await getDatabase()
    .update(telemetryDashboardWidgets)
    .set({ ...update, updatedAt: new Date() })
    .where(and(eq(telemetryDashboardWidgets.dashboardId, dashboardId), eq(telemetryDashboardWidgets.id, widgetId)))
    .returning(widgetColumns);
  if (!updated) return null;
  await touchDashboard(dashboardId);
  return updated;
}

export async function deleteTelemetryDashboardWidget(
  organizationId: string,
  dashboardId: string,
  widgetId: string,
): Promise<boolean> {
  if (!(await findDashboardRow(organizationId, dashboardId))) return false;
  const deleted = await getDatabase()
    .delete(telemetryDashboardWidgets)
    .where(and(eq(telemetryDashboardWidgets.dashboardId, dashboardId), eq(telemetryDashboardWidgets.id, widgetId)))
    .returning({ id: telemetryDashboardWidgets.id });
  if (deleted.length === 0) return false;
  await touchDashboard(dashboardId);
  return true;
}

// Moves and resizes widgets in one statement. False when the dashboard is not
// readable or a widget is not on it.
export async function updateTelemetryDashboardLayout(
  organizationId: string,
  dashboardId: string,
  widgets: Array<{ id: string; layout: DashboardWidgetLayout }>,
): Promise<boolean> {
  if (!(await findDashboardRow(organizationId, dashboardId))) return false;
  const ids = widgets.map((widget) => widget.id);
  if (new Set(ids).size !== ids.length) return false;
  return getDatabase().transaction(async (transaction) => {
    const owned = await transaction
      .select({ id: telemetryDashboardWidgets.id })
      .from(telemetryDashboardWidgets)
      .where(and(eq(telemetryDashboardWidgets.dashboardId, dashboardId), inArray(telemetryDashboardWidgets.id, ids)));
    if (owned.length !== ids.length) return false;
    const layouts = sql.join(
      widgets.map((widget) => sql`when ${widget.id}::uuid then ${JSON.stringify(widget.layout)}::jsonb`),
      sql` `,
    );
    await transaction
      .update(telemetryDashboardWidgets)
      .set({ layout: sql`case ${telemetryDashboardWidgets.id} ${layouts} end`, updatedAt: new Date() })
      .where(and(eq(telemetryDashboardWidgets.dashboardId, dashboardId), inArray(telemetryDashboardWidgets.id, ids)));
    await transaction
      .update(telemetryDashboards)
      .set({ updatedAt: new Date() })
      .where(eq(telemetryDashboards.id, dashboardId));
    return true;
  });
}
