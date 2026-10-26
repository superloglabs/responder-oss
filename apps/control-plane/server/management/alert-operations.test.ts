import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managementMcpRoutes } from "./mcp.js";
import { managementApiRoutes } from "./routes.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const userId = "21212121-2121-4121-8121-212121212121";
const apiKeyId = "31313131-3131-4131-8131-313131313131";
const alertId = "41414141-4141-4141-8141-414141414141";
const slackAccountId = "51515151-5151-4151-8151-515151515151";
const token = `slk_${"a".repeat(43)}`;

const mocks = vi.hoisted(() => ({
  alertValues: vi.fn(),
  authenticate: vi.fn(),
  capabilities: new Set<string>(),
  client: vi.fn(),
  createAlert: vi.fn(),
  deleteAlert: vi.fn(),
  episodes: vi.fn(),
  findAlert: vi.fn(),
  listAlerts: vi.fn(),
  slackChannels: vi.fn(),
  updateAlert: vi.fn(),
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
vi.mock("../../../../packages/core/src/telemetry/alert-values.js", () => ({
  alertValues: mocks.alertValues,
}));
vi.mock("../../../../packages/core/src/db/telemetry-alerts.js", () => ({
  createTelemetryAlert: mocks.createAlert,
  deleteTelemetryAlert: mocks.deleteAlert,
  findTelemetryAlert: mocks.findAlert,
  listTelemetryAlertEpisodes: mocks.episodes,
  listTelemetryAlerts: mocks.listAlerts,
  listTelemetryAlertSlackChannels: mocks.slackChannels,
  updateTelemetryAlert: mocks.updateAlert,
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

async function mcp(method: string, params?: Record<string, unknown>) {
  const response = await app.request("/api/mcp", {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  return (await response.json() as { result: Record<string, unknown> }).result;
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = await mcp("tools/call", { arguments: args, name }) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { body: JSON.parse(result.content[0]!.text) as Record<string, unknown>, isError: result.isError };
}

const slack = { channelId: "C0ALERTS", integrationAccountId: slackAccountId };
const alert = {
  aggregation: "count",
  comparator: "gt",
  createdAt: "2026-10-20T10:00:00.000Z",
  enabled: true,
  evaluationIntervalSeconds: 60,
  field: null,
  filter: { service: "api", severity: "ERROR" },
  groupBy: null,
  groupMode: "single",
  id: alertId,
  lastError: null,
  lastEvaluatedAt: "2026-10-26T10:00:00.000Z",
  metricName: null,
  name: "API errors",
  slack,
  source: "logs",
  threshold: 10,
  updatedAt: "2026-10-20T10:00:00.000Z",
  windowMinutes: 5,
};

describe("alert operations", () => {
  beforeEach(() => {
    mocks.authenticate.mockResolvedValue({
      apiKeyId,
      organizationId,
      role: "member",
      user: { email: "ash@example.com", id: userId, name: "Ash" },
    });
    mocks.capabilities = new Set(["telemetry", "alerts"]);
    mocks.client.mockReturnValue({});
    mocks.slackChannels.mockResolvedValue([
      { accountName: "Nautilus", channelId: "C0ALERTS", integrationAccountId: slackAccountId, name: "alerts", private: false },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("marks reads, additions, and replacements in the tool annotations", async () => {
    const { tools } = await mcp("tools/list") as { tools: Array<{ annotations: Record<string, unknown>; name: string }> };
    const annotations = (name: string) => tools.find((tool) => tool.name === name)?.annotations;

    for (const name of ["list_alerts", "get_alert", "preview_alert"]) {
      expect(annotations(name), name).toMatchObject({ destructiveHint: false, readOnlyHint: true });
    }
    expect(annotations("create_alert")).toMatchObject({ destructiveHint: false, readOnlyHint: false });
    for (const name of ["update_alert", "delete_alert"]) {
      expect(annotations(name), name).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    }
  });

  it("lists alerts with links to them", async () => {
    mocks.listAlerts.mockResolvedValue([{ ...alert, firingGroups: 1 }]);

    const result = await callTool("list_alerts");

    expect(mocks.listAlerts).toHaveBeenCalledWith(organizationId);
    expect(result.body).toEqual({
      alerts: [{ ...alert, firingGroups: 1, url: expect.stringMatching(new RegExp(`/alerts/${alertId}$`, "u")) }],
    });
  });

  it("returns an alert with its recent activations", async () => {
    mocks.findAlert.mockResolvedValue(alert);
    mocks.episodes.mockResolvedValue([{
      endReason: null,
      endedAt: null,
      groupKey: "",
      id: "61616161-6161-4161-8161-616161616161",
      lastValue: 14,
      openValue: 12,
      peakValue: 20,
      ruleSnapshot: { ...alert },
      startedAt: "2026-10-26T09:55:00.000Z",
      state: "firing",
    }]);

    const response = await api(`/alerts/${alertId}`);
    const body = await response.json() as { activations: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(mocks.episodes).toHaveBeenCalledWith(alertId, 20);
    expect(body.activations).toEqual([expect.objectContaining({ peakValue: 20, state: "firing" })]);
    expect(body.activations[0]).not.toHaveProperty("ruleSnapshot");
  });

  it("creates an alert as the caller with the page's defaults", async () => {
    mocks.createAlert.mockResolvedValue(alert);

    const response = await api("/alerts", "POST", {
      aggregation: "count",
      comparator: "gt",
      filter: { service: "api", severity: "ERROR" },
      name: "API errors",
      slack,
      source: "logs",
      threshold: 10,
    });

    expect(response.status).toBe(201);
    expect(mocks.createAlert).toHaveBeenCalledWith(organizationId, {
      aggregation: "count",
      comparator: "gt",
      createdBy: userId,
      enabled: true,
      evaluationIntervalSeconds: 60,
      field: null,
      filter: { service: "api", severity: "ERROR" },
      groupBy: null,
      groupMode: "single",
      metricName: null,
      name: "API errors",
      slack,
      source: "logs",
      threshold: 10,
      windowMinutes: 5,
    });
  });

  it("refuses a rule the alert could not evaluate", async () => {
    const result = await callTool("create_alert", {
      aggregation: "count",
      comparator: "gt",
      name: "Queue depth",
      source: "metric",
      threshold: 100,
    });

    expect(result.isError).toBe(true);
    expect(result.body).toMatchObject({ code: "invalid_request", issues: [{ message: "Choose a metric" }] });
    expect(mocks.createAlert).not.toHaveBeenCalled();
  });

  it("refuses a Slack channel the workspace cannot post to", async () => {
    const result = await callTool("create_alert", {
      aggregation: "count",
      comparator: "gt",
      name: "API errors",
      slack: { channelId: "C0PRIVATE", integrationAccountId: slackAccountId },
      source: "logs",
      threshold: 10,
    });

    expect(result.body.code).toBe("slack_channel_unavailable");
    expect(mocks.createAlert).not.toHaveBeenCalled();
  });

  it("changes only the fields sent and keeps the rest", async () => {
    mocks.findAlert.mockResolvedValue(alert);
    mocks.updateAlert.mockResolvedValue({ ...alert, threshold: 25 });

    const result = await callTool("update_alert", { alertId, threshold: 25 });

    expect(result.isError).toBeUndefined();
    expect(mocks.updateAlert).toHaveBeenCalledWith(organizationId, alertId, {
      aggregation: "count",
      comparator: "gt",
      enabled: true,
      evaluationIntervalSeconds: 60,
      field: null,
      filter: { service: "api", severity: "ERROR" },
      groupBy: null,
      groupMode: "single",
      metricName: null,
      name: "API errors",
      slack,
      source: "logs",
      threshold: 25,
      windowMinutes: 5,
    });
    expect(result.body.alert).toMatchObject({ threshold: 25 });
  });

  it("checks the merged alert, so a partial change cannot break the rule", async () => {
    mocks.findAlert.mockResolvedValue(alert);

    const result = await callTool("update_alert", { alertId, groupMode: "per_group" });

    expect(result.body).toMatchObject({ code: "invalid_request", issues: [{ message: "Choose what to group by" }] });
    expect(mocks.updateAlert).not.toHaveBeenCalled();
  });

  it("asks for a change and reports alerts that are gone", async () => {
    expect((await callTool("update_alert", { alertId })).body.code).toBe("nothing_to_update");

    mocks.findAlert.mockResolvedValue(null);
    expect((await callTool("update_alert", { alertId, enabled: false })).body.code).toBe("alert_not_found");

    mocks.deleteAlert.mockResolvedValue(false);
    expect((await api(`/alerts/${alertId}`, "DELETE")).status).toBe(404);
    expect(mocks.updateAlert).not.toHaveBeenCalled();
  });

  it("previews a rule with groups past the threshold first", async () => {
    mocks.alertValues.mockResolvedValue([
      { group: "web", value: 4 },
      { group: "api", value: 30 },
      { group: "worker", value: 12 },
    ]);

    const result = await callTool("preview_alert", {
      aggregation: "count",
      comparator: "gt",
      groupBy: "service.name",
      groupMode: "per_group",
      source: "logs",
      threshold: 10,
    });

    expect(mocks.alertValues).toHaveBeenCalledWith(
      {},
      organizationId,
      expect.objectContaining({ groupBy: "service.name", windowMinutes: 5 }),
      expect.any(Date),
    );
    expect(result.body).toEqual({
      evaluations: [
        { breaching: true, groupKey: "api", value: 30 },
        { breaching: true, groupKey: "worker", value: 12 },
        { breaching: false, groupKey: "web", value: 4 },
      ],
    });
  });

  it("is unavailable without alerts, telemetry, or a telemetry store", async () => {
    mocks.capabilities = new Set(["telemetry"]);
    expect((await callTool("list_alerts")).body.code).toBe("alerts_unavailable");

    mocks.capabilities = new Set(["alerts"]);
    expect((await api(`/alerts/${alertId}`)).status).toBe(404);

    mocks.capabilities = new Set(["telemetry", "alerts"]);
    mocks.client.mockReturnValue(null);
    expect((await callTool("delete_alert", { alertId })).body.code).toBe("alerts_unavailable");

    expect(mocks.listAlerts).not.toHaveBeenCalled();
    expect(mocks.findAlert).not.toHaveBeenCalled();
    expect(mocks.deleteAlert).not.toHaveBeenCalled();
  });
});
