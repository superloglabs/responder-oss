import { describe, expect, it, vi } from "vitest";
import { createTelemetryRoutes, type TelemetryRouteDependencies } from "./routes.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const projectId = "b925b1df-5b78-43c8-a816-6f00afb174af";
const now = new Date("2026-10-13T12:00:00.000Z");
const traceId = "5255bbc393af888bdef2e83d0e0c2990";

function routes(overrides: Partial<TelemetryRouteDependencies> = {}) {
  const dependencies: TelemetryRouteDependencies = {
    attributeKeys: vi.fn(async () => [{ count: 3, key: "resource.deployment.environment" }]),
    attributeValues: vi.fn(async () => [{ count: 3, value: "production" }]),
    client: () => ({}) as never,
    countAggregate: vi.fn(async (_client, _projectId, _source, _filter, groupBy: string) => [{ group: `${groupBy}-top`, value: 7 }]),
    countSeries: vi.fn(async () => [
      { bucket: "2026-10-13 11:00:00", count: 2, group: "api" },
      { bucket: "2026-10-13 11:30:00", count: 1, group: "web" },
    ]),
    findProject: vi.fn(async () => ({ name: "Default", projectId })),
    hasDashboards: vi.fn(async () => true),
    hasTelemetry: vi.fn(async () => true),
    listProjects: vi.fn(async () => [{ name: "Default", projectId }]),
    listServices: vi.fn(async () => ["checkout", "api"]),
    metricNames: vi.fn(async () => [{ kind: "histogram", name: "http.server.duration", unit: "ms" }]),
    metricSeries: vi.fn(async () => [{ bucket: "2026-10-13 11:00:00", group: "", value: 12.5 }]),
    now: () => now,
    queryLogs: vi.fn(async () => [{ body: "hello", service: "checkout" }]),
    queryTrace: vi.fn(async () => ({ logs: [], spans: [{ span_id: "a1" }] })),
    queryTraces: vi.fn(async () => [{ trace_id: traceId }]),
    tenant: vi.fn(async () => ({ ok: true as const, organizationId })),
    traceOverview: vi.fn(async () => ({
      dependencies: [],
      errors: [],
      operations: [],
      series: [],
      totals: { errors: 0, p95_ms: 0, requests: 0 },
    })),
    ...overrides,
  };
  return { app: createTelemetryRoutes(dependencies), dependencies };
}

describe("telemetry routes", () => {
  it("lists the workspace's linked projects", async () => {
    const { app } = routes();

    const response = await app.request("/projects");

    await expect(response.json()).resolves.toEqual({
      projects: [{ name: "Default", projectId }],
    });
  });

  it("queries logs of a linked project with the chosen filters and window", async () => {
    const { app, dependencies } = routes();

    const response = await app.request(
      `/logs?projectId=${projectId}&range=15m&service=checkout&severity=ERROR&search=timeout&limit=50`,
    );

    await expect(response.json()).resolves.toEqual({
      logs: [{ body: "hello", service: "checkout" }],
    });
    expect(dependencies.findProject).toHaveBeenCalledWith(organizationId, projectId);
    expect(dependencies.queryLogs).toHaveBeenCalledWith(expect.anything(), projectId, {
      limit: 50,
      range: { since: "2026-10-13T11:45:00.000Z", until: "2026-10-13T12:00:00.000Z" },
      search: "timeout",
      services: ["checkout"],
      severities: ["ERROR"],
    });
  });

  it("matches any of repeated values and attribute filters in the log explorer", async () => {
    const { app, dependencies } = routes();

    const response = await app.request(
      `/logs?projectId=${projectId}&severity=ERROR&severity=WARN&service=api&service=web` +
        `&filter=${encodeURIComponent("log.http.route=/checkout")}` +
        `&filter=${encodeURIComponent("resource.deployment.environment!=staging")}`,
    );

    expect(response.status).toBe(200);
    expect(dependencies.queryLogs).toHaveBeenCalledWith(expect.anything(), projectId, {
      limit: 100,
      range: { since: "2026-10-13T11:00:00.000Z", until: "2026-10-13T12:00:00.000Z" },
      resourceAttrs: [
        { key: "log.http.route", op: "eq", value: "/checkout" },
        { key: "resource.deployment.environment", op: "neq", value: "staging" },
      ],
      services: ["api", "web"],
      severities: ["ERROR", "WARN"],
    });
  });

  it("accepts a log search as long as the filter field allows", async () => {
    const { app } = routes();

    expect((await app.request(`/logs?projectId=${projectId}&search=${"a".repeat(500)}`)).status).toBe(200);
    expect((await app.request(`/logs?projectId=${projectId}&search=${"a".repeat(501)}`)).status).toBe(400);
  });

  it("counts matching logs per bucket and level for the explorer chart", async () => {
    const { app, dependencies } = routes();

    const response = await app.request(`/logs/histogram?projectId=${projectId}&search=timeout&service=api`);

    await expect(response.json()).resolves.toEqual({
      buckets: [
        { bucket: "2026-10-13 11:00:00", count: 2, group: "api" },
        { bucket: "2026-10-13 11:30:00", count: 1, group: "web" },
      ],
      since: "2026-10-13T11:00:00.000Z",
      stepMs: 30_000,
      until: "2026-10-13T12:00:00.000Z",
    });
    expect(dependencies.countSeries).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      "logs",
      {
        range: { since: "2026-10-13T11:00:00.000Z", until: "2026-10-13T12:00:00.000Z" },
        resourceAttrs: [],
        search: "timeout",
        services: ["api"],
      },
      "severity",
      { n: 30, unit: "SECOND" },
    );
  });

  it("counts over an explicit window with buckets sized to it", async () => {
    const { app, dependencies } = routes();
    const since = "2026-10-12T00:00:00.000Z";
    const until = "2026-10-12T06:00:00.000Z";

    const response = await app.request(`/logs/histogram?projectId=${projectId}&since=${since}&until=${until}`);

    await expect(response.json()).resolves.toMatchObject({ since, stepMs: 300_000, until });
    expect(dependencies.countSeries).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      "logs",
      expect.objectContaining({ range: { since, until } }),
      "severity",
      { n: 5, unit: "MINUTE" },
    );
    expect((await app.request(`/logs/facets?projectId=${projectId}&since=${since}`)).status).toBe(400);
  });

  it("counts each log facet without its own filter", async () => {
    const { app, dependencies } = routes();

    const response = await app.request(
      `/logs/facets?projectId=${projectId}&severity=ERROR&service=api&facet=log.http.route` +
        `&filter=${encodeURIComponent("log.http.route=/checkout")}`,
    );

    await expect(response.json()).resolves.toEqual({
      attributes: { "log.http.route": [{ group: "log.http.route-top", value: 7 }] },
      services: [{ group: "service-top", value: 7 }],
      severities: [{ group: "severity-top", value: 7 }],
    });
    const calls = vi.mocked(dependencies.countAggregate).mock.calls;
    const byGroup = Object.fromEntries(calls.map((call) => [call[4], call[3]]));
    expect(byGroup.severity).toMatchObject({ services: ["api"], severities: undefined });
    expect(byGroup.service).toMatchObject({ services: undefined, severities: ["ERROR"] });
    expect(byGroup["log.http.route"]).toMatchObject({ resourceAttrs: [], services: ["api"], severities: ["ERROR"] });
    expect((await app.request(`/logs/facets?projectId=${projectId}&facet=a&facet=b&facet=c&facet=d&facet=e&facet=f`)).status).toBe(400);
  });

  it("lists services seen in a linked project's window", async () => {
    const { app, dependencies } = routes();

    const response = await app.request(`/services?projectId=${projectId}&range=24h`);

    await expect(response.json()).resolves.toEqual({ services: ["checkout", "api"] });
    expect(dependencies.listServices).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      { since: "2026-10-12T12:00:00.000Z", until: "2026-10-13T12:00:00.000Z" },
      "logs",
    );

    await app.request(`/services?projectId=${projectId}&signal=all`);
    expect(dependencies.listServices).toHaveBeenLastCalledWith(expect.anything(), projectId, expect.anything(), undefined);

    await app.request(`/services?projectId=${projectId}&signal=traces`);
    expect(dependencies.listServices).toHaveBeenLastCalledWith(
      expect.anything(),
      projectId,
      expect.anything(),
      "traces",
    );
  });

  it("queries traces of a linked project with the chosen filters and window", async () => {
    const { app, dependencies } = routes();

    const response = await app.request(
      `/traces?projectId=${projectId}&range=6h&service=checkout&status=error&minDurationMs=500`,
    );

    await expect(response.json()).resolves.toEqual({ traces: [{ trace_id: traceId }] });
    expect(dependencies.queryTraces).toHaveBeenCalledWith(expect.anything(), projectId, {
      limit: 50,
      minDurationMs: 500,
      range: { since: "2026-10-13T06:00:00.000Z", until: "2026-10-13T12:00:00.000Z" },
      services: ["checkout"],
      statusCodes: ["STATUS_CODE_ERROR"],
    });

    await app.request(`/traces?projectId=${projectId}&operation=GET%20%2Fcart&status=STATUS_CODE_OK&status=STATUS_CODE_UNSET`);
    expect(dependencies.queryTraces).toHaveBeenLastCalledWith(expect.anything(), projectId, {
      limit: 50,
      range: { since: "2026-10-13T11:00:00.000Z", until: "2026-10-13T12:00:00.000Z" },
      spanNames: ["GET /cart"],
      statusCodes: ["STATUS_CODE_OK", "STATUS_CODE_UNSET"],
    });
  });

  it("counts matching spans per status, and each trace facet without its own filter", async () => {
    const { app, dependencies } = routes();

    const histogram = await app.request(`/traces/histogram?projectId=${projectId}&range=24h&status=error`);
    expect(histogram.status).toBe(200);
    expect(dependencies.countSeries).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      "traces",
      expect.objectContaining({ statusCodes: ["STATUS_CODE_ERROR"] }),
      "status",
      { n: 15, unit: "MINUTE" },
    );

    await app.request(`/traces/histogram?projectId=${projectId}&minDurationMs=600`);
    expect(dependencies.countSeries).toHaveBeenLastCalledWith(
      expect.anything(),
      projectId,
      "traces",
      expect.objectContaining({ minTraceDurationMs: 600 }),
      "status",
      expect.anything(),
    );
    expect(vi.mocked(dependencies.countSeries).mock.lastCall?.[3]).not.toHaveProperty("minDurationMs");

    const facets = await app.request(`/traces/facets?projectId=${projectId}&status=error&operation=checkout`);
    await expect(facets.json()).resolves.toEqual({
      attributes: {},
      operations: [{ group: "operation-top", value: 7 }],
      services: [{ group: "service-top", value: 7 }],
      statuses: [{ group: "status-top", value: 7 }],
    });
    const calls = vi.mocked(dependencies.countAggregate).mock.calls;
    const byGroup = Object.fromEntries(calls.map((call) => [call[4], call[3]]));
    expect(byGroup.status).toMatchObject({ spanNames: ["checkout"], statusCodes: undefined });
    expect(byGroup.operation).toMatchObject({ spanNames: undefined, statusCodes: ["STATUS_CODE_ERROR"] });
  });

  it("summarizes requests into a service for the traces overview", async () => {
    const { app, dependencies } = routes();

    const response = await app.request(
      `/traces/overview?projectId=${projectId}&service=checkout&filter=${encodeURIComponent("resource.deployment.environment=production")}`,
    );

    await expect(response.json()).resolves.toMatchObject({
      overview: { totals: { errors: 0, p95_ms: 0, requests: 0 } },
      since: "2026-10-13T11:00:00.000Z",
      stepMs: 30_000,
    });
    expect(dependencies.traceOverview).toHaveBeenCalledWith(expect.anything(), projectId, {
      range: { since: "2026-10-13T11:00:00.000Z", until: "2026-10-13T12:00:00.000Z" },
      resourceAttrs: [{ key: "resource.deployment.environment", op: "eq", value: "production" }],
      service: "checkout",
      step: { n: 30, unit: "SECOND" },
    });
  });

  it("returns a trace's spans and logs, and 404 for a trace with no spans", async () => {
    const { app, dependencies } = routes();

    const response = await app.request(`/traces/${traceId.toUpperCase()}?projectId=${projectId}`);

    await expect(response.json()).resolves.toEqual({ logs: [], spans: [{ span_id: "a1" }] });
    expect(dependencies.queryTrace).toHaveBeenCalledWith(expect.anything(), projectId, traceId);

    const empty = routes({ queryTrace: vi.fn(async () => ({ logs: [], spans: [] })) });
    expect((await empty.app.request(`/traces/${traceId}?projectId=${projectId}`)).status).toBe(404);
  });

  it("rejects malformed trace IDs and trace filters", async () => {
    const { app, dependencies } = routes();

    expect((await app.request(`/traces/not-a-trace?projectId=${projectId}`)).status).toBe(400);
    expect((await app.request(`/traces/${traceId}`)).status).toBe(400);
    expect((await app.request(`/traces?projectId=${projectId}&status=ok`)).status).toBe(400);
    expect((await app.request(`/traces?projectId=${projectId}&filter=no-operator`)).status).toBe(400);
    expect((await app.request(`/traces?projectId=${projectId}&minDurationMs=-1`)).status).toBe(400);
    expect(dependencies.queryTrace).not.toHaveBeenCalled();
    expect(dependencies.queryTraces).not.toHaveBeenCalled();
  });

  it("does not read a project the workspace has not linked", async () => {
    const { app, dependencies } = routes({ findProject: vi.fn(async () => null) });

    expect((await app.request(`/logs?projectId=${projectId}`)).status).toBe(404);
    expect((await app.request(`/traces?projectId=${projectId}`)).status).toBe(404);
    expect((await app.request(`/traces/${traceId}?projectId=${projectId}`)).status).toBe(404);
    expect(dependencies.queryLogs).not.toHaveBeenCalled();
    expect(dependencies.queryTraces).not.toHaveBeenCalled();
    expect(dependencies.queryTrace).not.toHaveBeenCalled();
  });

  it("lists attribute keys, values and metric names for a linked project", async () => {
    const { app, dependencies } = routes();
    const window = { since: "2026-10-13T11:00:00.000Z", until: "2026-10-13T12:00:00.000Z" };

    expect(await (await app.request(`/attribute-keys?projectId=${projectId}&source=metrics`)).json()).toEqual({
      keys: [{ count: 3, key: "resource.deployment.environment" }],
    });
    expect(dependencies.attributeKeys).toHaveBeenCalledWith(expect.anything(), projectId, window, "metrics");

    await app.request(`/attribute-values?projectId=${projectId}&key=service.name&prefix=ap`);
    expect(dependencies.attributeValues).toHaveBeenCalledWith(expect.anything(), projectId, {
      key: "service.name",
      prefix: "ap",
      range: window,
      source: "logs",
    });

    expect(await (await app.request(`/metric-names?projectId=${projectId}`)).json()).toEqual({
      metrics: [{ kind: "histogram", name: "http.server.duration", unit: "ms" }],
    });
    expect((await app.request(`/attribute-values?projectId=${projectId}`)).status).toBe(400);
  });

  it("lists attribute values that match other filters", async () => {
    const { app, dependencies } = routes();
    const filters = [{ key: "service.name", value: "checkout" }, { key: "env", value: "prod", values: ["prod", "staging"] }];

    const response = await app.request(
      `/attribute-values?projectId=${projectId}&key=http.route&filters=${encodeURIComponent(JSON.stringify(filters))}`,
    );

    expect(response.status).toBe(200);
    expect(dependencies.attributeValues).toHaveBeenCalledWith(expect.anything(), projectId, expect.objectContaining({ filters }));
    for (const invalid of ["nope", JSON.stringify([{ key: "" }])]) {
      const rejected = await app.request(`/attribute-values?projectId=${projectId}&key=k&filters=${encodeURIComponent(invalid)}`);
      expect(rejected.status).toBe(400);
    }
  });

  it("queries an explicit window up to 30 days long", async () => {
    const { app, dependencies } = routes();
    const since = "2026-10-06T22:00:00.000Z";
    const until = "2026-10-09T21:59:59.000Z";

    expect((await app.request(`/metric-names?projectId=${projectId}&since=${since}&until=${until}`)).status).toBe(200);
    expect(dependencies.metricNames).toHaveBeenCalledWith(expect.anything(), projectId, { since, until });

    for (const window of [
      `since=${since}`,
      `since=${until}&until=${since}`,
      "since=2026-09-01T00:00:00.000Z&until=2026-10-13T00:00:00.000Z",
      "since=yesterday&until=now",
    ]) {
      expect((await app.request(`/metric-names?projectId=${projectId}&${window}`)).status).toBe(400);
    }
  });

  describe("widget data", () => {
    function post(app: ReturnType<typeof routes>["app"], body: unknown) {
      return app.request("/widget-data", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    }

    it("charts counts per group with variables substituted into the filters", async () => {
      const { app, dependencies } = routes();

      const response = await post(app, {
        config: {
          filter: { resourceAttrs: [{ key: "deployment.environment", value: "$env" }] },
          groupBy: "service",
          limit: 1,
          source: "traces",
        },
        projectId,
        range: "1h",
        type: "timeseries_count",
        variables: { env: "production" },
      });

      const body = (await response.json()) as { chart: { buckets: number[]; series: unknown[]; stepMs: number } };
      expect(dependencies.countSeries).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        "traces",
        {
          range: { since: "2026-10-13T11:00:00.000Z", until: "2026-10-13T12:00:00.000Z" },
          resourceAttrs: [{ key: "deployment.environment", value: "production" }],
        },
        "service",
        { n: 30, unit: "SECOND" },
      );
      expect(body.chart.stepMs).toBe(30_000);
      expect(body.chart.buckets).toHaveLength(121);
      expect(body.chart.series).toEqual([
        expect.objectContaining({ name: "api", other: false }),
        expect.objectContaining({ name: "Other", other: true }),
      ]);
    });

    it("charts an explicit window, matching any selected value of a multi-value variable", async () => {
      const { app, dependencies } = routes();

      const response = await post(app, {
        config: {
          filter: {
            resourceAttrs: [
              { key: "http.route", value: "$route" },
              { key: "region", value: "$region" },
            ],
          },
        },
        projectId,
        since: "2026-10-12T10:00:00.000Z",
        type: "timeseries_count",
        until: "2026-10-12T12:00:00.000Z",
        variables: { region: [], route: ["POST /checkout", "POST /refunds"] },
      });

      expect(response.status).toBe(200);
      expect(dependencies.countSeries).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        "logs",
        {
          range: { since: "2026-10-12T10:00:00.000Z", until: "2026-10-12T12:00:00.000Z" },
          resourceAttrs: [{ key: "http.route", value: "POST /checkout", values: ["POST /checkout", "POST /refunds"] }],
        },
        undefined,
        { n: 1, unit: "MINUTE" },
      );
      expect(
        (await post(app, { config: {}, projectId, since: "2026-10-12T10:00:00.000Z", type: "log_table" })).status,
      ).toBe(400);
    });

    it("charts a metric and leaves its gaps empty", async () => {
      const { app, dependencies } = routes();

      const response = await post(app, {
        config: { aggregation: "p95", metricName: "http.server.duration" },
        projectId,
        range: "1h",
        type: "timeseries_metric",
      });

      const body = (await response.json()) as { chart: { series: Array<{ values: Array<number | null> }> } };
      expect(dependencies.metricSeries).toHaveBeenCalledWith(expect.anything(), projectId, {
        aggregation: "p95",
        filter: { range: expect.anything(), resourceAttrs: [] },
        groupBy: undefined,
        metricName: "http.server.duration",
        step: { n: 30, unit: "SECOND" },
      });
      expect(body.chart.series[0]!.values.filter((value) => value !== null)).toEqual([12.5]);
      expect(
        (await post(app, { config: {}, projectId, range: "1h", type: "timeseries_metric" })).status,
      ).toBe(400);
    });

    it("lists logs and traces for table widgets", async () => {
      const { app, dependencies } = routes();

      expect(
        await (await post(app, { config: { limit: 20 }, projectId, range: "15m", type: "log_table" })).json(),
      ).toEqual({ kind: "logs", logs: [{ body: "hello", service: "checkout" }] });
      expect(dependencies.queryLogs).toHaveBeenCalledWith(expect.anything(), projectId, {
        limit: 20,
        range: expect.anything(),
        resourceAttrs: [],
      });

      await post(app, { config: { limit: 500 }, projectId, range: "15m", type: "trace_table" });
      expect(dependencies.queryTraces).toHaveBeenCalledWith(expect.anything(), projectId, {
        limit: 200,
        range: expect.anything(),
        resourceAttrs: [],
      });
    });

    it("needs the dashboards capability", async () => {
      const { app, dependencies } = routes({ hasDashboards: vi.fn(async () => false) });

      expect((await post(app, { config: {}, projectId, range: "1h", type: "log_table" })).status).toBe(404);
      expect(dependencies.queryLogs).not.toHaveBeenCalled();
      expect(dependencies.hasDashboards).toHaveBeenCalledWith(organizationId);
    });

    it("rejects notes, invalid configs and unlinked projects", async () => {
      const { app } = routes();

      expect((await post(app, { config: {}, projectId, range: "1h", type: "markdown" })).status).toBe(400);
      expect(
        (await post(app, { config: { chartType: "pie" }, projectId, range: "1h", type: "timeseries_count" })).status,
      ).toBe(400);
      const unlinked = routes({ findProject: vi.fn(async () => null) });
      expect((await post(unlinked.app, { config: {}, projectId, range: "1h", type: "log_table" })).status).toBe(404);
      expect(unlinked.dependencies.queryLogs).not.toHaveBeenCalled();
    });
  });

  it("hides telemetry from a workspace without the capability or a configured store", async () => {
    for (const overrides of [
      { hasTelemetry: vi.fn(async () => false) },
      { client: () => null },
    ]) {
      const { app, dependencies } = routes(overrides);

      expect((await app.request("/projects")).status).toBe(404);
      expect((await app.request(`/logs?projectId=${projectId}`)).status).toBe(404);
      expect(dependencies.queryLogs).not.toHaveBeenCalled();
    }
  });

  it("rejects unknown ranges, oversized limits, and malformed project IDs", async () => {
    const { app } = routes();

    for (const query of [
      `projectId=${projectId}&range=90d`,
      `projectId=${projectId}&limit=5000`,
      "projectId=not-a-uuid",
    ]) {
      expect((await app.request(`/logs?${query}`)).status).toBe(400);
    }
  });

  it("passes the tenant failure through", async () => {
    const { app } = routes({
      tenant: vi.fn(async () => ({ error: "Unauthorized", ok: false as const, status: 401 as const })),
    });

    expect((await app.request("/projects")).status).toBe(401);
  });
});
