import { describe, expect, it, vi } from "vitest";
import type { TelemetryAlert } from "../../../../packages/core/src/db/telemetry-alerts.js";
import { createAlertRoutes, type AlertRouteDependencies } from "./alert-routes.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const alertId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-10-14T12:00:00.000Z");

const rule = {
  aggregation: "count",
  comparator: "gt",
  name: "Checkout errors",
  source: "logs",
  threshold: 10,
};
const alert: TelemetryAlert = {
  aggregation: "count",
  comparator: "gt",
  field: null,
  createdAt: now.toISOString(),
  enabled: true,
  evaluationIntervalSeconds: 60,
  filter: {},
  groupBy: null,
  groupMode: "single",
  id: alertId,
  lastError: null,
  lastEvaluatedAt: null,
  metricName: null,
  name: "Checkout errors",
  slack: null,
  source: "logs",
  threshold: 10,
  updatedAt: now.toISOString(),
  windowMinutes: 5,
};

function routes(overrides: Partial<AlertRouteDependencies> = {}) {
  const dependencies: AlertRouteDependencies = {
    client: () => ({}) as never,
    createAlert: vi.fn(async () => alert),
    deleteAlert: vi.fn(async () => true),
    episodes: vi.fn(async () => []),
    findAlert: vi.fn(async () => alert),
    findActivation: vi.fn(async () => null),
    hasCapability: vi.fn(async () => true),
    listAlerts: vi.fn(async () => [{ ...alert, firingGroups: 0 }]),
    now: () => now,
    refreshSlackChannels: vi.fn(async () => undefined),
    series: vi.fn(async () => [{ bucket: "2026-10-14 11:55:00", group: "", value: 12 }]),
    slackChannels: vi.fn(async () => [
      { accountName: "Acme", channelId: "C1", integrationAccountId: accountId, name: "alerts", private: false },
    ]),
    tenant: vi.fn(async () => ({ ok: true as const, organizationId, user: { id: userId } })),
    updateAlert: vi.fn(async () => alert),
    values: vi.fn(async () => [{ group: "", value: 12 }]),
    ...overrides,
  };
  return { app: createAlertRoutes(dependencies), dependencies };
}

function send(app: ReturnType<typeof routes>["app"], method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
}

describe("alert routes", () => {
  it("lists and reads alerts with their episodes", async () => {
    const { app, dependencies } = routes();

    expect(await (await app.request("/")).json()).toEqual({ alerts: [{ ...alert, firingGroups: 0 }] });
    expect(await (await app.request(`/${alertId}`)).json()).toEqual({ alert, episodes: [], hasFiringActivations: false });
    expect(dependencies.episodes).toHaveBeenCalledWith(alertId);
  });

  it("creates an alert with defaults, posting to a channel the workspace has", async () => {
    const { app, dependencies } = routes();

    const response = await send(app, "POST", "/", {
      ...rule,
      slack: { channelId: "C1", integrationAccountId: accountId },
    });

    expect(response.status).toBe(201);
    expect(dependencies.createAlert).toHaveBeenCalledWith(organizationId, expect.objectContaining({
      createdBy: userId,
      evaluationIntervalSeconds: 60,
      groupMode: "single",
      slack: { channelId: "C1", integrationAccountId: accountId },
      windowMinutes: 5,
    }));
  });

  it("rejects a channel the workspace cannot post to, and inconsistent rules", async () => {
    const { app, dependencies } = routes();

    const unknownChannel = await send(app, "POST", "/", {
      ...rule,
      slack: { channelId: "C9", integrationAccountId: accountId },
    });
    expect(unknownChannel.status).toBe(400);
    const summed = await send(app, "POST", "/", { ...rule, aggregation: "sum" });
    expect(await summed.json()).toEqual({ error: "Choose a field to aggregate" });
    expect(dependencies.createAlert).not.toHaveBeenCalled();
  });

  it("replaces and deletes alerts", async () => {
    const { app, dependencies } = routes();

    expect((await send(app, "PUT", `/${alertId}`, { ...rule, enabled: false })).status).toBe(200);
    expect(dependencies.updateAlert).toHaveBeenCalledWith(organizationId, alertId, expect.objectContaining({ enabled: false }));
    expect((await send(app, "DELETE", `/${alertId}`)).status).toBe(204);

    const missing = routes({ deleteAlert: vi.fn(async () => false), findAlert: vi.fn(async () => null), updateAlert: vi.fn(async () => null) });
    expect((await missing.app.request(`/${alertId}`)).status).toBe(404);
    expect((await missing.app.request("/not-an-alert")).status).toBe(404);
    expect((await send(missing.app, "PUT", `/${alertId}`, rule)).status).toBe(404);
    expect((await send(missing.app, "DELETE", `/${alertId}`)).status).toBe(404);
  });

  it("previews the current value and a chart one window per bucket", async () => {
    const { app, dependencies } = routes();

    const response = await send(app, "POST", "/preview", rule);
    const body = (await response.json()) as {
      chart: { buckets: number[]; stepMs: number };
      evaluations: unknown[];
    };

    expect(body.evaluations).toEqual([{ breaching: true, groupKey: "", value: 12 }]);
    expect(body.chart.stepMs).toBe(300_000);
    expect(body.chart.buckets).toHaveLength(25);
    expect(dependencies.values).toHaveBeenCalledWith(expect.anything(), organizationId, expect.objectContaining({ windowMinutes: 5 }), now);
  });

  it("lists the lowest values first for an alert on falling values", async () => {
    const { app } = routes({
      values: vi.fn(async () => [{ group: "a", value: 9 }, { group: "b", value: 2 }, { group: "c", value: 5 }]),
    });
    const response = await send(app, "POST", "/preview", {
      ...rule,
      comparator: "lt",
      groupBy: "service",
      groupMode: "per_group",
      threshold: 6,
    });
    const body = (await response.json()) as { evaluations: Array<{ groupKey: string }> };
    expect(body.evaluations.map((evaluation) => evaluation.groupKey)).toEqual(["b", "c", "a"]);
  });

  it("lists and refreshes Slack channels", async () => {
    const { app, dependencies } = routes();

    expect((await (await app.request("/slack-channels")).json()) as unknown).toMatchObject({ channels: [{ channelId: "C1" }] });
    await send(app, "POST", "/slack-channels/refresh");
    expect(dependencies.refreshSlackChannels).toHaveBeenCalledWith(organizationId);
  });

  it("hides alerts without both capabilities or a telemetry store", async () => {
    for (const overrides of [
      { hasCapability: vi.fn(async (_: string, capability: string) => capability !== "alerts") },
      { hasCapability: vi.fn(async (_: string, capability: string) => capability !== "telemetry") },
      { client: () => null },
    ]) {
      const { app, dependencies } = routes(overrides);
      expect((await app.request("/")).status).toBe(404);
      expect((await send(app, "POST", "/", rule)).status).toBe(404);
      expect(dependencies.createAlert).not.toHaveBeenCalled();
    }
  });
});

const activationId = "33333333-3333-4333-8333-333333333333";
const activation = {
  id: activationId, groupKey: "api", state: "resolved" as const,
  startedAt: "2026-10-14T11:35:00.000Z", endedAt: "2026-10-14T11:40:00.000Z",
  openValue: 12, peakValue: 20, lastValue: 4, ruleSnapshot: { ...alert, groupMode: "per_group" as const, groupBy: "service" },
  endReason: "recovered" as const, slackChannelId: "C1", slackMessageTs: null, recoveryNotifiedAt: null,
};

describe("activation details", () => {
  it("checks workspace ownership before reading history or an activation", async () => {
    const { app, dependencies } = routes({ findAlert: vi.fn(async () => null), findActivation: vi.fn(async () => activation) });
    for (const suffix of ["activations", `activations/${activationId}`, `activations/${activationId}/chart`]) {
      expect((await app.request(`/${alertId}/${suffix}`)).status).toBe(404);
    }
    expect(dependencies.findAlert).toHaveBeenCalledWith(organizationId, alertId);
    expect(dependencies.findActivation).not.toHaveBeenCalled();
    expect(dependencies.episodes).not.toHaveBeenCalled();
    expect(dependencies.series).not.toHaveBeenCalled();
  });

  it("scopes direct links to their parent and returns a missing activation", async () => {
    const { app, dependencies } = routes();
    expect((await app.request(`/${alertId}/activations/${activationId}`)).status).toBe(404);
    expect(dependencies.findActivation).toHaveBeenCalledWith(alertId, activationId);
  });

  it("reconstructs the activation group with its original rule", async () => {
    const { app, dependencies } = routes({
      findActivation: vi.fn(async () => activation),
      series: vi.fn(async () => [{ bucket: "2026-10-14 11:35:00", group: "api", value: 12 }, { bucket: "2026-10-14 11:35:00", group: "other", value: 99 }]),
    });
    expect(await (await app.request(`/${alertId}/activations/${activationId}`)).json()).toEqual({ alert, activation });
    const response = await app.request(`/${alertId}/activations/${activationId}/chart`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.chart.series).toHaveLength(1);
    expect(body.chart.series[0].name).toBe("api");
    expect(dependencies.series).toHaveBeenCalledWith(expect.anything(), organizationId, activation.ruleSnapshot, new Date("2026-10-14T11:55:00Z"), { since: "2026-10-14T11:20:00.000Z", until: "2026-10-14T11:55:00.000Z" });
  });

  it("does not apply today's rule to legacy activations", async () => {
    const { app, dependencies } = routes({ findActivation: vi.fn(async () => ({ ...activation, ruleSnapshot: null })) });
    const body = await (await app.request(`/${alertId}/activations/${activationId}/chart`)).json();
    expect(body.chart).toBeNull();
    expect(body.reason).toContain("not recorded");
    expect(dependencies.series).not.toHaveBeenCalled();
  });

  it("filters and paginates history in the database", async () => {
    const { app, dependencies } = routes({ episodes: vi.fn(async () => Array.from({ length: 51 }, () => activation)) });
    const response = await app.request(`/${alertId}/activations?days=7&state=resolved&offset=50`);
    const body = await response.json();
    expect(body.hasMore).toBe(true);
    expect(body.episodes).toHaveLength(50);
    expect(dependencies.episodes).toHaveBeenCalledWith(alertId, 51, { offset: 50, since: new Date("2026-10-07T12:00:00.000Z"), state: "resolved" });
    expect((await app.request(`/${alertId}/activations?offset=-1`)).status).toBe(400);
    expect((await app.request(`/${alertId}/activations?state=invalid`)).status).toBe(400);
  });

  it("validates preview ranges and queries the chosen range", async () => {
    const { app, dependencies } = routes();
    expect((await send(app, "POST", "/preview?hours=100", rule)).status).toBe(400);
    expect((await send(app, "POST", "/preview?hours=6", rule)).status).toBe(200);
    expect(dependencies.series).toHaveBeenCalledWith(expect.anything(), organizationId, expect.anything(), now, { since: "2026-10-14T06:00:00.000Z", until: now.toISOString() });
  });
});

describe("large activation histories", () => {
  it("reports an open activation even when it is older than the latest history page", async () => {
    const { app, dependencies } = routes({ episodes: vi.fn<AlertRouteDependencies["episodes"]>(async (_id, _limit, options) => options?.state === "firing" ? [{ ...activation, state: "firing", endedAt: null }] : Array.from({ length: 50 }, () => activation)) });
    const body = await (await app.request(`/${alertId}`)).json();
    expect(body.hasFiringActivations).toBe(true);
    expect(body.episodes).toHaveLength(50);
    expect(dependencies.episodes).toHaveBeenCalledWith(alertId, 1, { state: "firing" });
  });

  it("allows the next history page beyond ten thousand activations", async () => {
    const { app, dependencies } = routes();
    const response = await app.request(`/${alertId}/activations?days=all&offset=10050`);
    expect(response.status).toBe(200);
    expect(dependencies.episodes).toHaveBeenCalledWith(alertId, 51, { offset: 10050 });
  });
});
