import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managementMcpRoutes } from "./mcp.js";
import { managementApiRoutes } from "./routes.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const userId = "21212121-2121-4121-8121-212121212121";
const apiKeyId = "31313131-3131-4131-8131-313131313131";
const dashboardId = "41414141-4141-4141-8141-414141414141";
const widgetId = "51515151-5151-4151-8151-515151515151";
const token = `slk_${"a".repeat(43)}`;

const mocks = vi.hoisted(() => ({
  addWidget: vi.fn(),
  authenticate: vi.fn(),
  capabilities: new Set<string>(),
  client: vi.fn(),
  createDashboard: vi.fn(),
  deleteDashboard: vi.fn(),
  deleteWidget: vi.fn(),
  findDashboard: vi.fn(),
  listDashboards: vi.fn(),
  updateDashboard: vi.fn(),
  updateLayout: vi.fn(),
  updateWidget: vi.fn(),
}));

vi.mock("../../../../packages/core/src/db/api-keys.js", () => ({
  authenticateApiKey: mocks.authenticate,
  listApiKeys: vi.fn().mockResolvedValue([]),
  revokeApiKey: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/oauth-access-tokens.js", () => ({
  authenticateOAuthAccessToken: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/organization-capabilities.js", () => ({
  listEnabledOrganizationCapabilities: vi.fn().mockResolvedValue([]),
  organizationHasCapability: vi.fn(async (_organization: string, capability: string) => mocks.capabilities.has(capability)),
}));
vi.mock("../../../../packages/core/src/telemetry/client.js", () => ({
  getTelemetryClient: mocks.client,
}));
vi.mock("../../../../packages/core/src/db/telemetry-dashboards.js", () => ({
  addTelemetryDashboardWidget: mocks.addWidget,
  createTelemetryDashboard: mocks.createDashboard,
  deleteTelemetryDashboard: mocks.deleteDashboard,
  deleteTelemetryDashboardWidget: mocks.deleteWidget,
  findTelemetryDashboard: mocks.findDashboard,
  listTelemetryDashboards: mocks.listDashboards,
  updateTelemetryDashboard: mocks.updateDashboard,
  updateTelemetryDashboardLayout: mocks.updateLayout,
  updateTelemetryDashboardWidget: mocks.updateWidget,
}));

const app = new Hono()
  .route("/api/v1", managementApiRoutes)
  .route("/api/mcp", managementMcpRoutes);

function api(path: string, method = "GET", body?: unknown) {
  return app.request(`/api/v1${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    method,
  });
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const response = await app.request("/api/mcp", {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: args, name } }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  const { result } = await response.json() as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  return { body: JSON.parse(result.content[0]!.text) as Record<string, unknown>, isError: result.isError };
}

const chart = {
  config: { filter: { resourceAttrs: [{ key: "deployment.environment", value: "$env" }] }, groupBy: "service.name", source: "logs" },
  id: widgetId,
  layout: { h: 4, w: 6, x: 0, y: 0 },
  position: 0,
  title: "Errors by service",
  type: "timeseries_count",
};
const dashboard = {
  id: dashboardId,
  name: "Checkout",
  updatedAt: "2026-10-16T10:00:00.000Z",
  variables: [{ name: "env", options: ["prod", "staging"], defaultValue: "prod" }],
  widgets: [chart],
};

describe("dashboard operations", () => {
  beforeEach(() => {
    mocks.authenticate.mockResolvedValue({
      apiKeyId,
      organizationId,
      role: "member",
      user: { email: "ash@example.com", id: userId, name: "Ash" },
    });
    mocks.capabilities = new Set(["telemetry", "dashboards"]);
    mocks.client.mockReturnValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("marks reads, additions, and replacements in the tool annotations", async () => {
    const response = await app.request("/api/mcp", {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const { result } = await response.json() as {
      result: { tools: Array<{ annotations: Record<string, unknown>; name: string }> };
    };
    const annotations = (name: string) => result.tools.find((tool) => tool.name === name)?.annotations;

    for (const name of ["list_dashboards", "get_dashboard"]) {
      expect(annotations(name), name).toMatchObject({ destructiveHint: false, readOnlyHint: true });
    }
    for (const name of ["create_dashboard", "add_dashboard_widget", "update_dashboard_layout"]) {
      expect(annotations(name), name).toMatchObject({ destructiveHint: false, readOnlyHint: false });
    }
    for (const name of ["update_dashboard", "delete_dashboard", "update_dashboard_widget", "delete_dashboard_widget"]) {
      expect(annotations(name), name).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    }
  });

  it("lists dashboards with links to them", async () => {
    mocks.listDashboards.mockResolvedValue([{ id: dashboardId, name: "Checkout", updatedAt: dashboard.updatedAt, widgetCount: 1 }]);

    const result = await callTool("list_dashboards");

    expect(mocks.listDashboards).toHaveBeenCalledWith(organizationId);
    expect(result.body).toEqual({
      dashboards: [{
        id: dashboardId,
        name: "Checkout",
        updatedAt: dashboard.updatedAt,
        url: expect.stringMatching(new RegExp(`/dashboards/${dashboardId}$`, "u")),
        widgetCount: 1,
      }],
    });
  });

  it("creates a dashboard as the caller with its variables", async () => {
    mocks.createDashboard.mockResolvedValue({ ...dashboard, widgets: [] });

    const response = await api("/dashboards", "POST", { name: "Checkout", variables: dashboard.variables });
    const body = await response.json() as { dashboard: { url: string } };

    expect(response.status).toBe(201);
    expect(mocks.createDashboard).toHaveBeenCalledWith(organizationId, {
      createdBy: userId,
      name: "Checkout",
      variables: dashboard.variables,
    });
    expect(body.dashboard.url).toMatch(`/dashboards/${dashboardId}`);
  });

  it("rejects variables whose default is not an option", async () => {
    const result = await callTool("create_dashboard", {
      name: "Checkout",
      variables: [{ defaultValue: "dev", name: "env", options: ["prod"] }],
    });

    expect(result.isError).toBe(true);
    expect(result.body.code).toBe("invalid_request");
    expect(mocks.createDashboard).not.toHaveBeenCalled();
  });

  it("adds a widget with the standard size for its type", async () => {
    mocks.addWidget.mockResolvedValue(chart);

    const result = await callTool("add_dashboard_widget", {
      config: chart.config,
      dashboardId,
      title: "Errors by service",
      type: "timeseries_count",
    });

    expect(result.isError).toBeUndefined();
    expect(mocks.addWidget).toHaveBeenCalledWith(organizationId, dashboardId, {
      config: chart.config,
      layout: { h: 4, w: 6, x: 0, y: 100_000 },
      title: "Errors by service",
      type: "timeseries_count",
    });
    expect(result.body).toEqual({ widget: chart });
  });

  it("refuses a chart the dashboard could not query", async () => {
    const result = await callTool("add_dashboard_widget", {
      config: { source: "logs" },
      dashboardId,
      title: "Latency",
      type: "timeseries_metric",
    });

    expect(result).toEqual({
      body: {
        code: "invalid_request",
        error: "Invalid widget",
        issues: [{ message: "Choose a metric", path: ["config", "metricName"] }],
      },
      isError: true,
    });
    expect(mocks.addWidget).not.toHaveBeenCalled();
  });

  it("checks a changed config against the widget's type", async () => {
    mocks.findDashboard.mockResolvedValue(dashboard);

    const invalid = await callTool("update_dashboard_widget", {
      config: { aggregation: "p95", source: "logs" },
      dashboardId,
      widgetId,
    });
    expect(invalid.body.issues).toEqual([{ message: "Choose a field to aggregate", path: ["config", "field"] }]);
    expect(mocks.updateWidget).not.toHaveBeenCalled();

    mocks.updateWidget.mockResolvedValue({ ...chart, title: "Slow spans" });
    const renamed = await callTool("update_dashboard_widget", { dashboardId, title: "Slow spans", widgetId });
    expect(renamed.body).toEqual({ widget: { ...chart, title: "Slow spans" } });
    expect(mocks.updateWidget).toHaveBeenCalledWith(organizationId, dashboardId, widgetId, { title: "Slow spans" });
  });

  it("asks for a change when an update sends none", async () => {
    expect((await callTool("update_dashboard", { dashboardId })).body.code).toBe("nothing_to_update");
    expect((await callTool("update_dashboard_widget", { dashboardId, widgetId })).body.code).toBe("nothing_to_update");
    expect(mocks.updateDashboard).not.toHaveBeenCalled();
    expect(mocks.updateWidget).not.toHaveBeenCalled();
  });

  it("moves widgets and returns the updated dashboard", async () => {
    mocks.updateLayout.mockResolvedValue(true);
    mocks.findDashboard.mockResolvedValue(dashboard);

    const response = await api(`/dashboards/${dashboardId}/layout`, "PATCH", {
      widgets: [{ id: widgetId, layout: { h: 4, w: 12, x: 0, y: 0 } }],
    });

    expect(response.status).toBe(200);
    expect(mocks.updateLayout).toHaveBeenCalledWith(organizationId, dashboardId, [
      { id: widgetId, layout: { h: 4, w: 12, x: 0, y: 0 } },
    ]);
  });

  it("refuses a layout past the grid", async () => {
    const result = await callTool("update_dashboard_layout", {
      dashboardId,
      widgets: [{ id: widgetId, layout: { h: 4, w: 8, x: 6, y: 0 } }],
    });

    expect(result.body.code).toBe("invalid_request");
    expect(mocks.updateLayout).not.toHaveBeenCalled();
  });

  it("deletes dashboards and widgets, and reports ones that are gone", async () => {
    mocks.deleteWidget.mockResolvedValue(true);
    expect((await api(`/dashboards/${dashboardId}/widgets/${widgetId}`, "DELETE")).status).toBe(200);
    expect(mocks.deleteWidget).toHaveBeenCalledWith(organizationId, dashboardId, widgetId);

    mocks.deleteDashboard.mockResolvedValue(false);
    expect(await callTool("delete_dashboard", { dashboardId })).toEqual({
      body: { code: "dashboard_not_found", error: "Dashboard not found" },
      isError: true,
    });
  });

  it("is unavailable without dashboards, telemetry, or a telemetry store", async () => {
    mocks.capabilities = new Set(["telemetry"]);
    expect((await callTool("list_dashboards")).body.code).toBe("dashboards_unavailable");

    mocks.capabilities = new Set(["dashboards"]);
    expect((await callTool("create_dashboard", { name: "Checkout" })).body.code).toBe("dashboards_unavailable");

    mocks.capabilities = new Set(["telemetry", "dashboards"]);
    mocks.client.mockReturnValue(null);
    expect((await api(`/dashboards/${dashboardId}`)).status).toBe(404);

    expect(mocks.listDashboards).not.toHaveBeenCalled();
    expect(mocks.createDashboard).not.toHaveBeenCalled();
    expect(mocks.findDashboard).not.toHaveBeenCalled();
  });
});
