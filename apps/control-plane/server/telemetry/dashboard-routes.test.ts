import { describe, expect, it, vi } from "vitest";
import { createDashboardRoutes, type DashboardRouteDependencies } from "./dashboard-routes.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const dashboardId = "11111111-1111-4111-8111-111111111111";
const widgetId = "22222222-2222-4222-8222-222222222222";

const dashboard = {
  id: dashboardId,
  name: "Checkout",
  updatedAt: "2026-10-13T12:00:00.000Z",
  variables: [],
  widgets: [],
};
const widget = {
  config: { filter: {}, source: "logs" as const },
  id: widgetId,
  layout: { h: 4, w: 6, x: 0, y: 100_000 },
  position: 0,
  title: "Log volume",
  type: "timeseries_count" as const,
};

function routes(overrides: Partial<DashboardRouteDependencies> = {}) {
  const dependencies: DashboardRouteDependencies = {
    addWidget: vi.fn(async () => widget),
    createDashboard: vi.fn(async () => dashboard),
    deleteDashboard: vi.fn(async () => true),
    deleteWidget: vi.fn(async () => true),
    findDashboard: vi.fn(async () => dashboard),
    hasCapability: vi.fn(async () => true),
    listDashboards: vi.fn(async () => [{ ...dashboard, widgetCount: 0 }]),
    storeConfigured: () => true,
    tenant: vi.fn(async () => ({ ok: true as const, organizationId, user: { id: userId } })),
    updateDashboard: vi.fn(async () => dashboard),
    updateLayout: vi.fn(async () => true),
    updateWidget: vi.fn(async () => widget),
    ...overrides,
  };
  return { app: createDashboardRoutes(dependencies), dependencies };
}

function send(app: ReturnType<typeof routes>["app"], method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
}

describe("dashboard routes", () => {
  it("lists and reads the workspace's dashboards", async () => {
    const { app, dependencies } = routes();

    expect(await (await app.request("/")).json()).toEqual({ dashboards: [{ ...dashboard, widgetCount: 0 }] });
    expect(await (await app.request(`/${dashboardId}`)).json()).toEqual({ dashboard });
    expect(dependencies.findDashboard).toHaveBeenCalledWith(organizationId, dashboardId);
  });

  it("creates a dashboard in the workspace", async () => {
    const { app, dependencies } = routes();

    const created = await send(app, "POST", "/", { name: "Checkout" });
    expect(created.status).toBe(201);
    expect(dependencies.createDashboard).toHaveBeenCalledWith(organizationId, {
      createdBy: userId,
      name: "Checkout",
    });
  });

  it("renames, sets variables, and deletes", async () => {
    const { app, dependencies } = routes();
    const variables = [{ defaultValue: "production", name: "env", options: ["production", "staging"] }];

    expect((await send(app, "PATCH", `/${dashboardId}`, { name: "Payments", variables })).status).toBe(200);
    expect(dependencies.updateDashboard).toHaveBeenCalledWith(organizationId, dashboardId, {
      name: "Payments",
      variables,
    });
    expect((await send(app, "PATCH", `/${dashboardId}`, {})).status).toBe(400);
    expect((await send(app, "DELETE", `/${dashboardId}`)).status).toBe(204);
  });

  it("adds a widget at its type's default size", async () => {
    const { app, dependencies } = routes();

    const response = await send(app, "POST", `/${dashboardId}/widgets`, {
      config: { source: "logs" },
      title: "Log volume",
      type: "timeseries_count",
    });

    expect(response.status).toBe(201);
    expect(dependencies.addWidget).toHaveBeenCalledWith(organizationId, dashboardId, {
      config: { filter: {}, source: "logs" },
      layout: { h: 4, w: 6, x: 0, y: 100_000 },
      title: "Log volume",
      type: "timeseries_count",
    });
  });

  it("updates widgets and the layout, and deletes widgets", async () => {
    const { app, dependencies } = routes();
    const layout = { h: 5, w: 12, x: 0, y: 0 };

    expect((await send(app, "PATCH", `/${dashboardId}/widgets/${widgetId}`, { title: "Errors" })).status).toBe(200);
    expect(dependencies.updateWidget).toHaveBeenCalledWith(organizationId, dashboardId, widgetId, { title: "Errors" });
    expect((await send(app, "PATCH", `/${dashboardId}/layout`, { widgets: [{ id: widgetId, layout }] })).status).toBe(
      204,
    );
    expect(dependencies.updateLayout).toHaveBeenCalledWith(organizationId, dashboardId, [{ id: widgetId, layout }]);
    expect((await send(app, "DELETE", `/${dashboardId}/widgets/${widgetId}`)).status).toBe(204);
  });

  it("returns 404 for dashboards and widgets the workspace cannot read", async () => {
    const { app } = routes({
      addWidget: vi.fn(async () => null),
      deleteDashboard: vi.fn(async () => false),
      deleteWidget: vi.fn(async () => false),
      findDashboard: vi.fn(async () => null),
      updateDashboard: vi.fn(async () => null),
      updateLayout: vi.fn(async () => false),
      updateWidget: vi.fn(async () => null),
    });
    const layout = { h: 4, w: 6, x: 0, y: 0 };

    expect((await app.request(`/${dashboardId}`)).status).toBe(404);
    expect((await app.request("/not-a-dashboard")).status).toBe(404);
    expect((await send(app, "PATCH", `/${dashboardId}`, { name: "x" })).status).toBe(404);
    expect((await send(app, "DELETE", `/${dashboardId}`)).status).toBe(404);
    expect(
      (await send(app, "POST", `/${dashboardId}/widgets`, { config: {}, title: "x", type: "markdown" })).status,
    ).toBe(404);
    expect((await send(app, "PATCH", `/${dashboardId}/widgets/${widgetId}`, { title: "x" })).status).toBe(404);
    expect((await send(app, "DELETE", `/${dashboardId}/widgets/${widgetId}`)).status).toBe(404);
    expect((await send(app, "PATCH", `/${dashboardId}/layout`, { widgets: [{ id: widgetId, layout }] })).status).toBe(
      404,
    );
  });

  it("rejects invalid widgets and layouts", async () => {
    const { app, dependencies } = routes();

    expect(
      (await send(app, "POST", `/${dashboardId}/widgets`, { config: {}, title: "x", type: "service_map" })).status,
    ).toBe(400);
    expect(
      (await send(app, "PATCH", `/${dashboardId}/layout`, { widgets: [{ id: widgetId, layout: { h: 1, w: 6, x: 9, y: 0 } }] }))
        .status,
    ).toBe(400);
    expect(dependencies.addWidget).not.toHaveBeenCalled();
    expect(dependencies.updateLayout).not.toHaveBeenCalled();
  });

  it("hides dashboards without both capabilities or a telemetry store", async () => {
    for (const overrides of [
      { hasCapability: vi.fn(async (_: string, capability: string) => capability !== "dashboards") },
      { hasCapability: vi.fn(async (_: string, capability: string) => capability !== "telemetry") },
      { storeConfigured: () => false },
    ]) {
      const { app, dependencies } = routes(overrides);
      expect((await app.request("/")).status).toBe(404);
      expect((await send(app, "POST", "/", { name: "x" })).status).toBe(404);
      expect(dependencies.createDashboard).not.toHaveBeenCalled();
    }
  });

  it("passes the tenant failure through", async () => {
    const { app } = routes({
      tenant: vi.fn(async () => ({ error: "Unauthorized", ok: false as const, status: 401 as const })),
    });
    expect((await app.request("/")).status).toBe(401);
  });
});
