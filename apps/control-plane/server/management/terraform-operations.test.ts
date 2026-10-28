import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managementApiRoutes } from "./routes.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const userId = "21212121-2121-4121-8121-212121212121";
const alertId = "11111111-1111-4111-8111-111111111111";
const dashboardId = "22222222-2222-4222-8222-222222222222";
const checkId = "55555555-5555-4555-8555-555555555555";
const token = `slk_${"a".repeat(43)}`;

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  capabilities: new Set<string>(),
  client: vi.fn(),
  findDashboard: vi.fn(),
  listAlerts: vi.fn(),
  listChecks: vi.fn(),
  listDashboards: vi.fn(),
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
vi.mock("../../../../packages/core/src/db/telemetry-alerts.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listTelemetryAlerts: mocks.listAlerts,
  listTelemetryAlertSlackChannels: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../../../packages/core/src/db/telemetry-dashboards.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findTelemetryDashboard: mocks.findDashboard,
  listTelemetryDashboards: mocks.listDashboards,
}));
vi.mock("../../../../packages/core/src/db/synthetic-checks.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listSyntheticChecks: mocks.listChecks,
}));

const app = new Hono().route("/api/v1", managementApiRoutes);

async function exportTerraform(query = "") {
  const response = await app.request(`/api/v1/terraform${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { body: await response.json() as Record<string, unknown>, status: response.status };
}

const alert = {
  aggregation: "count",
  comparator: "gt",
  enabled: true,
  evaluationIntervalSeconds: 60,
  field: null,
  filter: {},
  groupBy: null,
  groupMode: "single",
  id: alertId,
  metricName: null,
  name: "Checkout errors",
  slack: null,
  source: "logs",
  threshold: 50,
  windowMinutes: 5,
};
const dashboard = { id: dashboardId, name: "Checkout", updatedAt: "2026-10-28T10:00:00.000Z", variables: [], widgets: [] };
const check = {
  assertions: [],
  body: null,
  enabled: true,
  failuresToAlert: 1,
  followRedirects: true,
  headers: [],
  id: checkId,
  intervalSeconds: 300,
  method: "GET",
  name: "API health",
  retries: 1,
  slack: null,
  timeoutMs: 10_000,
  url: "https://api.example.com/health",
};

describe("terraform export operation", () => {
  beforeEach(() => {
    mocks.authenticate.mockResolvedValue({
      apiKeyId: null,
      organizationId,
      role: "member",
      user: { email: "ash@example.com", id: userId, name: "Ash" },
    });
    mocks.capabilities = new Set(["telemetry", "alerts", "dashboards"]);
    mocks.client.mockReturnValue({});
    mocks.listAlerts.mockResolvedValue([alert]);
    mocks.listDashboards.mockResolvedValue([{ id: dashboardId, name: "Checkout", updatedAt: dashboard.updatedAt, widgetCount: 0 }]);
    mocks.findDashboard.mockResolvedValue(dashboard);
    mocks.listChecks.mockResolvedValue([check]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("exports everything without IDs", async () => {
    const { body, status } = await exportTerraform();

    expect(status).toBe(200);
    expect(body.resources).toBe(3);
    expect(body.hcl).toContain('resource "superlog_alert" "checkout_errors"');
    expect(body.hcl).toContain('resource "superlog_dashboard" "checkout"');
    expect(body.hcl).toContain('resource "superlog_synthetic_check" "api_health"');
  });

  it("exports only the objects asked for", async () => {
    const { body } = await exportTerraform(`?syntheticCheckIds=${checkId}`);

    expect(body.resources).toBe(1);
    expect(body.hcl).not.toContain("superlog_alert");
    expect(mocks.listAlerts).not.toHaveBeenCalled();
    expect(mocks.listDashboards).not.toHaveBeenCalled();
  });

  it("leaves out kinds the workspace cannot use", async () => {
    mocks.capabilities = new Set(["alerts"]);

    const { body } = await exportTerraform();

    expect(body.resources).toBe(1);
    expect(body.hcl).toContain("superlog_synthetic_check");
    expect(mocks.listAlerts).not.toHaveBeenCalled();
  });

  it("reports IDs it cannot find or use", async () => {
    const missing = "99999999-9999-4999-8999-999999999999";
    expect(await exportTerraform(`?alertIds=${alertId},${missing}`)).toEqual({
      body: { code: "not_found", error: `Not found: ${missing}` },
      status: 404,
    });

    mocks.capabilities = new Set(["alerts"]);
    expect((await exportTerraform(`?dashboardIds=${dashboardId}`)).status).toBe(404);

    expect((await exportTerraform("?alertIds=nope")).status).toBe(400);
  });
});
