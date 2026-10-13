import { Hono } from "hono";
import { z } from "zod";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import {
  addTelemetryDashboardWidget,
  createTelemetryDashboard,
  deleteTelemetryDashboard,
  deleteTelemetryDashboardWidget,
  findTelemetryDashboard,
  listTelemetryDashboards,
  updateTelemetryDashboard,
  updateTelemetryDashboardLayout,
  updateTelemetryDashboardWidget,
} from "../../../../packages/core/src/db/telemetry-dashboards.js";
import { findTelemetryProject } from "../../../../packages/core/src/db/telemetry-projects.js";
import { getTelemetryClient } from "../../../../packages/core/src/telemetry/client.js";
import {
  dashboardCreateSchema,
  dashboardLayoutUpdateSchema,
  dashboardUpdateSchema,
  dashboardWidgetCreateSchema,
  dashboardWidgetUpdateSchema,
  defaultWidgetLayout,
} from "../../../../packages/core/src/telemetry/dashboards.js";
import { getActiveTenant } from "../tenant.js";

// Dashboards over a workspace's telemetry projects. They need the telemetry
// and dashboards capabilities and a configured telemetry store.
export type DashboardRouteDependencies = {
  addWidget: typeof addTelemetryDashboardWidget;
  createDashboard: typeof createTelemetryDashboard;
  deleteDashboard: typeof deleteTelemetryDashboard;
  deleteWidget: typeof deleteTelemetryDashboardWidget;
  findDashboard: typeof findTelemetryDashboard;
  findProject: typeof findTelemetryProject;
  hasCapability: (organizationId: string, capability: "dashboards" | "telemetry") => Promise<boolean>;
  listDashboards: typeof listTelemetryDashboards;
  storeConfigured: () => boolean;
  tenant: (
    headers: Headers,
  ) => Promise<
    | { ok: true; organizationId: string; user: { id: string } }
    | { error: string; ok: false; status: 401 | 403 | 409 }
  >;
  updateDashboard: typeof updateTelemetryDashboard;
  updateLayout: typeof updateTelemetryDashboardLayout;
  updateWidget: typeof updateTelemetryDashboardWidget;
};

const defaultDependencies: DashboardRouteDependencies = {
  addWidget: addTelemetryDashboardWidget,
  createDashboard: createTelemetryDashboard,
  deleteDashboard: deleteTelemetryDashboard,
  deleteWidget: deleteTelemetryDashboardWidget,
  findDashboard: findTelemetryDashboard,
  findProject: findTelemetryProject,
  hasCapability: organizationHasCapability,
  listDashboards: listTelemetryDashboards,
  storeConfigured: () => getTelemetryClient() !== null,
  tenant: getActiveTenant,
  updateDashboard: updateTelemetryDashboard,
  updateLayout: updateTelemetryDashboardLayout,
  updateWidget: updateTelemetryDashboardWidget,
};

const idSchema = z.uuid();

async function jsonBody(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
}

export function createDashboardRoutes(dependencies: DashboardRouteDependencies = defaultDependencies) {
  async function access(headers: Headers): Promise<
    | { ok: true; organizationId: string; userId: string }
    | { error: string; ok: false; status: 401 | 403 | 404 | 409 }
  > {
    const tenant = await dependencies.tenant(headers);
    if (tenant.ok === false) return { error: tenant.error, ok: false, status: tenant.status };
    const [telemetry, dashboards] = await Promise.all([
      dependencies.hasCapability(tenant.organizationId, "telemetry"),
      dependencies.hasCapability(tenant.organizationId, "dashboards"),
    ]);
    if (!dependencies.storeConfigured() || !telemetry || !dashboards) {
      return { error: "Dashboards are not available", ok: false, status: 404 };
    }
    return { ok: true, organizationId: tenant.organizationId, userId: tenant.user.id };
  }

  const notFound = { error: "Dashboard not found" };

  return new Hono()
    .get("/", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      return context.json({ dashboards: await dependencies.listDashboards(granted.organizationId) });
    })
    .post("/", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const body = dashboardCreateSchema.safeParse(await jsonBody(context.req.raw));
      if (!body.success) return context.json({ error: "Invalid dashboard" }, 400);
      if (!(await dependencies.findProject(granted.organizationId, body.data.projectId))) {
        return context.json({ error: "Telemetry project not found" }, 404);
      }
      const dashboard = await dependencies.createDashboard(granted.organizationId, {
        createdBy: granted.userId,
        ...body.data,
      });
      return context.json({ dashboard }, 201);
    })
    .get("/:dashboardId", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const dashboardId = idSchema.safeParse(context.req.param("dashboardId"));
      if (!dashboardId.success) return context.json(notFound, 404);
      const dashboard = await dependencies.findDashboard(granted.organizationId, dashboardId.data);
      return dashboard ? context.json({ dashboard }) : context.json(notFound, 404);
    })
    .patch("/:dashboardId", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const dashboardId = idSchema.safeParse(context.req.param("dashboardId"));
      if (!dashboardId.success) return context.json(notFound, 404);
      const body = dashboardUpdateSchema.safeParse(await jsonBody(context.req.raw));
      if (!body.success) return context.json({ error: "Invalid dashboard" }, 400);
      const dashboard = await dependencies.updateDashboard(granted.organizationId, dashboardId.data, body.data);
      return dashboard ? context.json({ dashboard }) : context.json(notFound, 404);
    })
    .delete("/:dashboardId", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const dashboardId = idSchema.safeParse(context.req.param("dashboardId"));
      if (!dashboardId.success) return context.json(notFound, 404);
      return (await dependencies.deleteDashboard(granted.organizationId, dashboardId.data))
        ? context.body(null, 204)
        : context.json(notFound, 404);
    })
    .post("/:dashboardId/widgets", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const dashboardId = idSchema.safeParse(context.req.param("dashboardId"));
      if (!dashboardId.success) return context.json(notFound, 404);
      const body = dashboardWidgetCreateSchema.safeParse(await jsonBody(context.req.raw));
      if (!body.success) return context.json({ error: "Invalid widget" }, 400);
      const widget = await dependencies.addWidget(granted.organizationId, dashboardId.data, {
        ...body.data,
        layout: body.data.layout ?? defaultWidgetLayout(body.data.type),
      });
      return widget ? context.json({ widget }, 201) : context.json(notFound, 404);
    })
    .patch("/:dashboardId/layout", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const dashboardId = idSchema.safeParse(context.req.param("dashboardId"));
      if (!dashboardId.success) return context.json(notFound, 404);
      const body = dashboardLayoutUpdateSchema.safeParse(await jsonBody(context.req.raw));
      if (!body.success) return context.json({ error: "Invalid layout" }, 400);
      return (await dependencies.updateLayout(granted.organizationId, dashboardId.data, body.data.widgets))
        ? context.body(null, 204)
        : context.json({ error: "Dashboard or widget not found" }, 404);
    })
    .patch("/:dashboardId/widgets/:widgetId", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const dashboardId = idSchema.safeParse(context.req.param("dashboardId"));
      const widgetId = idSchema.safeParse(context.req.param("widgetId"));
      if (!dashboardId.success || !widgetId.success) return context.json({ error: "Widget not found" }, 404);
      const body = dashboardWidgetUpdateSchema.safeParse(await jsonBody(context.req.raw));
      if (!body.success) return context.json({ error: "Invalid widget" }, 400);
      const widget = await dependencies.updateWidget(granted.organizationId, dashboardId.data, widgetId.data, body.data);
      return widget ? context.json({ widget }) : context.json({ error: "Widget not found" }, 404);
    })
    .delete("/:dashboardId/widgets/:widgetId", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const dashboardId = idSchema.safeParse(context.req.param("dashboardId"));
      const widgetId = idSchema.safeParse(context.req.param("widgetId"));
      if (!dashboardId.success || !widgetId.success) return context.json({ error: "Widget not found" }, 404);
      return (await dependencies.deleteWidget(granted.organizationId, dashboardId.data, widgetId.data))
        ? context.body(null, 204)
        : context.json({ error: "Widget not found" }, 404);
    });
}
