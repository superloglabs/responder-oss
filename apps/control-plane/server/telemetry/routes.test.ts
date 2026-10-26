import { describe, expect, it, vi } from "vitest";
import { emptyAiPriceParams } from "../../../../packages/core/src/telemetry/ai-cost.js";
import { createTelemetryRoutes, type TelemetryRouteDependencies } from "./routes.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const now = new Date("2026-10-13T12:00:00.000Z");
const traceId = "5255bbc393af888bdef2e83d0e0c2990";

function routes(overrides: Partial<TelemetryRouteDependencies> = {}) {
  const dependencies: TelemetryRouteDependencies = {
    aiCallsWithoutUsage: vi.fn(async () => 3),
    aiModels: vi.fn(async () => [
      { calls: 40, inputTokens: 90_000, model: "gpt-5-2025-08-07", outputTokens: 12_000, provider: "openai", tier: "" },
      { calls: 2, inputTokens: 1_000, model: "ft:gpt-4o:acme", outputTokens: 100, provider: "openai", tier: "" },
    ]),
    aiPriceOverrides: vi.fn(async () => []),
    deleteAiPriceOverride: vi.fn(async () => true),
    resolveAiPrices: vi.fn(() => ({
      params: { ...emptyAiPriceParams(), aiPriceKey: ["openai|gpt-5-2025-08-07|"] },
      prices: [
        {
          card: { cacheRead: 0.125, cacheWrite: 1.25, input: 1.25, long: null, output: 10, threshold: null },
          catalogModel: "gpt-5",
          model: "gpt-5-2025-08-07",
          provider: "openai",
          source: "catalogue" as const,
          tier: "",
        },
      ],
      unpriced: [{ model: "ft:gpt-4o:acme", provider: "openai", tier: "" }],
    })),
    saveAiPriceOverride: vi.fn(async (_organizationId, price) => ({ ...price, id: "4d0c7c4e-8a51-4c62-9a0b-0f7d2b7f6a11" })),
    updateAiPriceOverride: vi.fn(async (_organizationId, id, price) => ({ ...price, id })),
    attributeKeys: vi.fn(async () => [{ count: 3, key: "resource.deployment.environment" }]),
    attributeValues: vi.fn(async () => [{ count: 3, value: "production" }]),
    client: () => ({}) as never,
    countAggregate: vi.fn(async (_client, _organizationId, _source, _filter, groupBy: string | undefined) => [{ group: groupBy ? `${groupBy}-top` : "", value: 7 }]),
    countSeries: vi.fn(async () => [
      { bucket: "2026-10-13 11:00:00", count: 2, group: "api" },
      { bucket: "2026-10-13 11:30:00", count: 1, group: "web" },
    ]),
    eventAggregate: vi.fn(async (_client, _organizationId, _source, _filter, _measure, groupBy: string | undefined) => [
      { group: groupBy ? `${groupBy}-top` : "", value: 4.5 },
    ]),
    eventSeries: vi.fn(async () => [
      { bucket: "2026-10-13 11:00:00", group: "api", value: 120 },
      { bucket: "2026-10-13 11:30:00", group: "web", value: 80 },
    ]),
    hasDashboards: vi.fn(async () => true),
    hasTelemetry: vi.fn(async () => true),
    listServices: vi.fn(async () => ["checkout", "api"]),
    metricCatalog: vi.fn(async () => [
      {
        attributes: ["http.route"],
        description: "Duration of HTTP server requests",
        kind: "histogram",
        name: "http.server.duration",
        series: 4,
        services: ["checkout"],
        unit: "ms",
      },
    ]),
    metricDimensions: vi.fn(async () => [
      { cardinality: 2, key: "attr:http.route", name: "http.route", scope: "point", values: [] },
    ]),
    metricNames: vi.fn(async () => [{ kind: "histogram", name: "http.server.duration", unit: "ms" }]),
    metricSeries: vi.fn(async () => [{ bucket: "2026-10-13 11:00:00", group: "", value: 12.5 }]),
    metricWindowAggregate: vi.fn(async () => [{ group: "", value: 12.5 }]),
    now: () => now,
    overview: vi.fn(async () => ({ ai: null, bucketSeconds: 1_800, services: [] })),
    overviewDetails: vi.fn(async () => ({
      ai: { calls: 0, callsWithInput: 0, callsWithModel: 0, callsWithOutput: 0, callsWithoutUsage: 0, completedCalls: 0, completedGenerations: 0, models: [], services: [] },
      errorsWithoutException: null,
      requests: [],
      withTrace: { checkout: 4 },
    })),
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
  it("tells the workspace it can read telemetry", async () => {
    const { app } = routes();

    const response = await app.request("/status");

    await expect(response.json()).resolves.toEqual({ available: true });
  });

  it("queries logs with the chosen filters and window", async () => {
    const { app, dependencies } = routes();

    const response = await app.request(
      `/logs?range=15m&service=checkout&severity=ERROR&search=timeout&limit=50`,
    );

    await expect(response.json()).resolves.toEqual({
      logs: [{ body: "hello", service: "checkout" }],
    });
    expect(dependencies.queryLogs).toHaveBeenCalledWith(expect.anything(), organizationId, {
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
      `/logs?severity=ERROR&severity=WARN&service=api&service=web` +
        `&filter=${encodeURIComponent("log.http.route=/checkout")}` +
        `&filter=${encodeURIComponent("resource.deployment.environment!=staging")}`,
    );

    expect(response.status).toBe(200);
    expect(dependencies.queryLogs).toHaveBeenCalledWith(expect.anything(), organizationId, {
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

    expect((await app.request(`/logs?search=${"a".repeat(500)}`)).status).toBe(200);
    expect((await app.request(`/logs?search=${"a".repeat(501)}`)).status).toBe(400);
  });

  it("counts matching logs per bucket and level for the explorer chart", async () => {
    const { app, dependencies } = routes();

    const response = await app.request("/logs/histogram?search=timeout&service=api");

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
      organizationId,
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

    const response = await app.request(`/logs/histogram?since=${since}&until=${until}`);

    await expect(response.json()).resolves.toMatchObject({ since, stepMs: 300_000, until });
    expect(dependencies.countSeries).toHaveBeenCalledWith(
      expect.anything(),
      organizationId,
      "logs",
      expect.objectContaining({ range: { since, until } }),
      "severity",
      { n: 5, unit: "MINUTE" },
    );
    expect((await app.request(`/logs/facets?since=${since}`)).status).toBe(400);
  });

  it("counts each log facet without its own filter", async () => {
    const { app, dependencies } = routes();

    const filters = `severity=ERROR&service=api&filter=${encodeURIComponent("log.http.route=/checkout")}`;

    const response = await app.request(`/logs/facets?${filters}`);
    await expect(response.json()).resolves.toEqual({
      services: [{ group: "service-top", value: 7 }],
      severities: [{ group: "severity-top", value: 7 }],
    });
    const attribute = await app.request(`/logs/facets/attribute?key=log.http.route&${filters}`);
    await expect(attribute.json()).resolves.toEqual({ values: [{ group: "log.http.route-top", value: 7 }] });

    const calls = vi.mocked(dependencies.countAggregate).mock.calls;
    const byGroup = Object.fromEntries(calls.map((call) => [call[4], call[3]]));
    expect(byGroup.severity).toMatchObject({ services: ["api"], severities: undefined });
    expect(byGroup.service).toMatchObject({ services: undefined, severities: ["ERROR"] });
    expect(byGroup["log.http.route"]).toMatchObject({ resourceAttrs: [], services: ["api"], severities: ["ERROR"] });
    expect((await app.request("/logs/facets/attribute")).status).toBe(400);
    expect((await app.request(`/logs/facets/attribute?key=${"a".repeat(201)}`)).status).toBe(400);
  });

  it("lists services seen in the window", async () => {
    const { app, dependencies } = routes();

    const response = await app.request("/services?range=24h");

    await expect(response.json()).resolves.toEqual({ services: ["checkout", "api"] });
    expect(dependencies.listServices).toHaveBeenCalledWith(
      expect.anything(),
      organizationId,
      { since: "2026-10-12T12:00:00.000Z", until: "2026-10-13T12:00:00.000Z" },
      "logs",
    );

    await app.request("/services?signal=all");
    expect(dependencies.listServices).toHaveBeenLastCalledWith(expect.anything(), organizationId, expect.anything(), undefined);

    await app.request("/services?signal=traces");
    expect(dependencies.listServices).toHaveBeenLastCalledWith(
      expect.anything(),
      organizationId,
      expect.anything(),
      "traces",
    );
  });

  it("queries traces with the chosen filters and window", async () => {
    const { app, dependencies } = routes();

    const response = await app.request(
      `/traces?range=6h&service=checkout&status=error&minDurationMs=500`,
    );

    await expect(response.json()).resolves.toEqual({ traces: [{ trace_id: traceId }] });
    expect(dependencies.queryTraces).toHaveBeenCalledWith(expect.anything(), organizationId, {
      limit: 50,
      minDurationMs: 500,
      range: { since: "2026-10-13T06:00:00.000Z", until: "2026-10-13T12:00:00.000Z" },
      services: ["checkout"],
      statusCodes: ["STATUS_CODE_ERROR"],
    });

    await app.request("/traces?operation=GET%20%2Fcart&status=STATUS_CODE_OK&status=STATUS_CODE_UNSET");
    expect(dependencies.queryTraces).toHaveBeenLastCalledWith(expect.anything(), organizationId, {
      limit: 50,
      range: { since: "2026-10-13T11:00:00.000Z", until: "2026-10-13T12:00:00.000Z" },
      spanNames: ["GET /cart"],
      statusCodes: ["STATUS_CODE_OK", "STATUS_CODE_UNSET"],
    });
  });

  it("counts matching spans per status, and each trace facet without its own filter", async () => {
    const { app, dependencies } = routes();

    const histogram = await app.request("/traces/histogram?range=24h&status=error");
    expect(histogram.status).toBe(200);
    expect(dependencies.countSeries).toHaveBeenCalledWith(
      expect.anything(),
      organizationId,
      "traces",
      expect.objectContaining({ statusCodes: ["STATUS_CODE_ERROR"] }),
      "status",
      { n: 15, unit: "MINUTE" },
    );

    await app.request("/traces/histogram?minDurationMs=600");
    expect(dependencies.countSeries).toHaveBeenLastCalledWith(
      expect.anything(),
      organizationId,
      "traces",
      expect.objectContaining({ minTraceDurationMs: 600 }),
      "status",
      expect.anything(),
    );
    expect(vi.mocked(dependencies.countSeries).mock.lastCall?.[3]).not.toHaveProperty("minDurationMs");

    const facets = await app.request("/traces/facets?status=error&operation=checkout");
    await expect(facets.json()).resolves.toEqual({
      operations: [{ group: "operation-top", value: 7 }],
      services: [{ group: "service-top", value: 7 }],
      statuses: [{ group: "status-top", value: 7 }],
    });
    const calls = vi.mocked(dependencies.countAggregate).mock.calls;
    const byGroup = Object.fromEntries(calls.map((call) => [call[4], call[3]]));
    expect(byGroup.status).toMatchObject({ spanNames: ["checkout"], statusCodes: undefined });
    expect(byGroup.operation).toMatchObject({ spanNames: undefined, statusCodes: ["STATUS_CODE_ERROR"] });

    const attribute = await app.request(
      `/traces/facets/attribute?key=span.http.route&status=error&filter=${encodeURIComponent("span.http.route=/cart")}` +
        `&filter=${encodeURIComponent("resource.deployment.environment=production")}`,
    );
    await expect(attribute.json()).resolves.toEqual({ values: [{ group: "span.http.route-top", value: 7 }] });
    expect(vi.mocked(dependencies.countAggregate).mock.lastCall?.slice(2, 5)).toEqual([
      "traces",
      expect.objectContaining({
        resourceAttrs: [{ key: "resource.deployment.environment", op: "eq", value: "production" }],
        statusCodes: ["STATUS_CODE_ERROR"],
      }),
      "span.http.route",
    ]);
  });

  it("summarizes requests into a service for the traces overview", async () => {
    const { app, dependencies } = routes();

    const response = await app.request(
      `/traces/overview?service=checkout&filter=${encodeURIComponent("resource.deployment.environment=production")}`,
    );

    await expect(response.json()).resolves.toMatchObject({
      overview: { totals: { errors: 0, p95_ms: 0, requests: 0 } },
      since: "2026-10-13T11:00:00.000Z",
      stepMs: 30_000,
    });
    expect(dependencies.traceOverview).toHaveBeenCalledWith(expect.anything(), organizationId, {
      range: { since: "2026-10-13T11:00:00.000Z", until: "2026-10-13T12:00:00.000Z" },
      resourceAttrs: [{ key: "resource.deployment.environment", op: "eq", value: "production" }],
      service: "checkout",
      step: { n: 30, unit: "SECOND" },
    });
  });

  it("summarizes what each service sent for the telemetry overview", async () => {
    const { app, dependencies } = routes();

    const response = await app.request("/overview?range=24h");

    await expect(response.json()).resolves.toMatchObject({
      overview: { bucketSeconds: 1_800, services: [] },
      since: "2026-10-12T12:00:00.000Z",
      until: "2026-10-13T12:00:00.000Z",
    });
    expect(dependencies.overview).toHaveBeenCalledWith(expect.anything(), organizationId, {
      since: "2026-10-12T12:00:00.000Z",
      until: "2026-10-13T12:00:00.000Z",
    });
    expect((await app.request("/overview?range=3d")).status).toBe(400);
    const unavailable = routes({ hasTelemetry: vi.fn(async () => false) });
    expect((await unavailable.app.request("/overview")).status).toBe(404);
  });

  it("returns the overview's details separately", async () => {
    const { app, dependencies } = routes();

    const response = await app.request("/overview/details?range=7d");

    await expect(response.json()).resolves.toMatchObject({
      details: { errorsWithoutException: null, requests: [], withTrace: { checkout: 4 } },
    });
    expect(dependencies.overviewDetails).toHaveBeenCalledWith(expect.anything(), organizationId, {
      since: "2026-10-06T12:00:00.000Z",
      until: "2026-10-13T12:00:00.000Z",
    });
    expect((await app.request("/overview/details?range=3d")).status).toBe(400);
    const unavailable = routes({ hasTelemetry: vi.fn(async () => false) });
    expect((await unavailable.app.request("/overview/details")).status).toBe(404);
  });

  it("returns a trace's spans and logs, and 404 for a trace with no spans", async () => {
    const { app, dependencies } = routes();

    const response = await app.request(`/traces/${traceId.toUpperCase()}`);

    await expect(response.json()).resolves.toEqual({ logs: [], spans: [{ span_id: "a1" }] });
    expect(dependencies.queryTrace).toHaveBeenCalledWith(expect.anything(), organizationId, traceId);

    const empty = routes({ queryTrace: vi.fn(async () => ({ logs: [], spans: [] })) });
    expect((await empty.app.request(`/traces/${traceId}`)).status).toBe(404);
  });

  it("rejects malformed trace IDs and trace filters", async () => {
    const { app, dependencies } = routes();

    expect((await app.request("/traces/not-a-trace")).status).toBe(400);
    expect((await app.request("/traces?status=ok")).status).toBe(400);
    expect((await app.request("/traces?filter=no-operator")).status).toBe(400);
    expect((await app.request("/traces?minDurationMs=-1")).status).toBe(400);
    expect(dependencies.queryTrace).not.toHaveBeenCalled();
    expect(dependencies.queryTraces).not.toHaveBeenCalled();
  });

  it("lists attribute keys, values and metric names", async () => {
    const { app, dependencies } = routes();
    const window = { since: "2026-10-13T11:00:00.000Z", until: "2026-10-13T12:00:00.000Z" };

    expect(await (await app.request("/attribute-keys?source=metrics")).json()).toEqual({
      keys: [{ count: 3, key: "resource.deployment.environment" }],
    });
    expect(dependencies.attributeKeys).toHaveBeenCalledWith(expect.anything(), organizationId, window, "metrics");

    await app.request("/attribute-values?key=service.name&prefix=ap");
    expect(dependencies.attributeValues).toHaveBeenCalledWith(expect.anything(), organizationId, {
      key: "service.name",
      prefix: "ap",
      range: window,
      source: "logs",
    });

    expect(await (await app.request("/metric-names")).json()).toEqual({
      metrics: [{ kind: "histogram", name: "http.server.duration", unit: "ms" }],
    });
    expect((await app.request("/attribute-values")).status).toBe(400);
  });

  it("lists attribute values that match other filters", async () => {
    const { app, dependencies } = routes();
    const filters = [{ key: "service.name", value: "checkout" }, { key: "env", value: "prod", values: ["prod", "staging"] }];

    const response = await app.request(
      `/attribute-values?key=http.route&filters=${encodeURIComponent(JSON.stringify(filters))}`,
    );

    expect(response.status).toBe(200);
    expect(dependencies.attributeValues).toHaveBeenCalledWith(expect.anything(), organizationId, expect.objectContaining({ filters }));
    for (const invalid of ["nope", JSON.stringify([{ key: "" }])]) {
      const rejected = await app.request(`/attribute-values?key=k&filters=${encodeURIComponent(invalid)}`);
      expect(rejected.status).toBe(400);
    }
  });

  it("queries an explicit window up to 30 days long", async () => {
    const { app, dependencies } = routes();
    const since = "2026-10-06T22:00:00.000Z";
    const until = "2026-10-09T21:59:59.000Z";

    expect((await app.request(`/metric-names?since=${since}&until=${until}`)).status).toBe(200);
    expect(dependencies.metricNames).toHaveBeenCalledWith(expect.anything(), organizationId, { since, until });

    for (const window of [
      `since=${since}`,
      `since=${until}&until=${since}`,
      "since=2026-09-01T00:00:00.000Z&until=2026-10-13T00:00:00.000Z",
      "since=yesterday&until=now",
    ]) {
      expect((await app.request(`/metric-names?${window}`)).status).toBe(400);
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
        range: "1h",
        type: "timeseries_count",
        variables: { env: "production" },
      });

      const body = (await response.json()) as { chart: { buckets: number[]; series: unknown[]; stepMs: number } };
      expect(dependencies.countSeries).toHaveBeenCalledWith(
        expect.anything(),
        organizationId,
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
        since: "2026-10-12T10:00:00.000Z",
        type: "timeseries_count",
        until: "2026-10-12T12:00:00.000Z",
        variables: { region: [], route: ["POST /checkout", "POST /refunds"] },
      });

      expect(response.status).toBe(200);
      expect(dependencies.countSeries).toHaveBeenCalledWith(
        expect.anything(),
        organizationId,
        "logs",
        {
          range: { since: "2026-10-12T10:00:00.000Z", until: "2026-10-12T12:00:00.000Z" },
          resourceAttrs: [{ key: "http.route", value: "POST /checkout", values: ["POST /checkout", "POST /refunds"] }],
        },
        undefined,
        { n: 1, unit: "MINUTE" },
      );
      expect(
        (await post(app, { config: {}, since: "2026-10-12T10:00:00.000Z", type: "log_table" })).status,
      ).toBe(400);
    });

    it("charts a metric and leaves its gaps empty", async () => {
      const { app, dependencies } = routes();

      const response = await post(app, {
        config: { aggregation: "p95", metricKind: "histogram", metricName: "http.server.duration", metricUnit: "ms" },
        range: "1h",
        type: "timeseries_metric",
      });

      const body = (await response.json()) as { chart: { series: Array<{ values: Array<number | null> }> } };
      expect(dependencies.metricSeries).toHaveBeenCalledWith(expect.anything(), organizationId, {
        aggregation: "p95",
        filter: { range: expect.anything(), resourceAttrs: [] },
        groupBy: undefined,
        kind: "histogram",
        metricName: "http.server.duration",
        step: { n: 30, unit: "SECOND" },
        unit: "ms",
      });
      expect(body.chart.series[0]!.values.filter((value) => value !== null)).toEqual([12.5]);
      expect(
        (await post(app, { config: {}, range: "1h", type: "timeseries_metric" })).status,
      ).toBe(400);
    });

    it("charts a percentile of a span field without an Other series or zero fill", async () => {
      const { app, dependencies } = routes();

      const response = await post(app, {
        config: { aggregation: "p95", field: "duration", groupBy: "service", limit: 1, source: "traces" },
        range: "1h",
        type: "timeseries_count",
      });

      const body = (await response.json()) as { chart: { series: Array<{ name: string; values: Array<number | null> }> } };
      expect(dependencies.eventSeries).toHaveBeenCalledWith(
        expect.anything(),
        organizationId,
        "traces",
        { range: expect.anything(), resourceAttrs: [] },
        { aggregation: "p95", field: "duration" },
        "service",
        { n: 30, unit: "SECOND" },
        undefined,
      );
      expect(dependencies.countSeries).not.toHaveBeenCalled();
      expect(body.chart.series.map((series) => series.name)).toEqual(["api"]);
      expect(body.chart.series[0]!.values.filter((value) => value !== null)).toEqual([120]);
      expect(
        (await post(app, { config: { aggregation: "p95", source: "traces" }, range: "1h", type: "timeseries_count" }))
          .status,
      ).toBe(400);
    });

    it("shows one number for the window, compared with the window before", async () => {
      const { app, dependencies } = routes();

      const response = await post(app, {
        config: {
          aggregation: "sum",
          compare: "previous_period",
          display: "number",
          field: "span.gen_ai.usage.output_tokens",
          groupBy: "service",
          source: "traces",
        },
        range: "1h",
        type: "timeseries_count",
      });

      expect(await response.json()).toEqual({ kind: "number", previous: 4.5, value: 4.5 });
      const measure = { aggregation: "sum", field: "span.gen_ai.usage.output_tokens" };
      expect(dependencies.eventAggregate).toHaveBeenCalledWith(
        expect.anything(),
        organizationId,
        "traces",
        { range: { since: "2026-10-13T11:00:00.000Z", until: "2026-10-13T12:00:00.000Z" }, resourceAttrs: [] },
        measure,
        undefined,
        1,
        undefined,
      );
      expect(dependencies.eventAggregate).toHaveBeenCalledWith(
        expect.anything(),
        organizationId,
        "traces",
        { range: { since: "2026-10-13T10:00:00.000Z", until: "2026-10-13T11:00:00.000Z" }, resourceAttrs: [] },
        measure,
        undefined,
        1,
        undefined,
      );
    });

    it("counts nothing as zero, and leaves other measures empty", async () => {
      const empty = vi.fn(async () => []);
      const { app } = routes({ countAggregate: empty, eventAggregate: empty });

      const count = await post(app, { config: { display: "number" }, range: "1h", type: "timeseries_count" });
      const average = await post(app, {
        config: { aggregation: "avg", display: "number", field: "duration", source: "traces" },
        range: "1h",
        type: "timeseries_count",
      });

      expect(await count.json()).toEqual({ kind: "number", value: 0 });
      expect(await average.json()).toEqual({ kind: "number", value: null });
    });

    it("lists a value per group, with each group's value the window before", async () => {
      const { app, dependencies } = routes({
        countAggregate: vi.fn(async (_client, _organizationId, _source, filter) =>
          filter.range?.since === "2026-10-13T11:00:00.000Z"
            ? [{ group: "api", value: 7 }, { group: "web", value: 3 }]
            : [{ group: "api", value: 5 }],
        ),
      });

      const response = await post(app, {
        config: { compare: "previous_period", display: "table", groupBy: "service", limit: 5 },
        range: "1h",
        type: "timeseries_count",
      });

      expect(await response.json()).toEqual({
        kind: "rows",
        rows: [
          { group: "api", previous: 5, value: 7 },
          { group: "web", previous: 0, value: 3 },
        ],
      });
      expect(dependencies.countAggregate).toHaveBeenCalledWith(expect.anything(), organizationId, "logs", expect.anything(), "service", 5);
    });

    it("lists a metric per group over the whole window", async () => {
      const { app, dependencies } = routes();

      const response = await post(app, {
        config: { aggregation: "p99", display: "bar_list", groupBy: "service", limit: 3, metricName: "http.server.duration" },
        range: "1h",
        type: "timeseries_metric",
      });

      expect(await response.json()).toEqual({ kind: "rows", rows: [{ group: "", value: 12.5 }] });
      expect(dependencies.metricWindowAggregate).toHaveBeenCalledWith(expect.anything(), organizationId, {
        aggregation: "p99",
        filter: { range: expect.anything(), resourceAttrs: [] },
        groupBy: "service",
        limit: 3,
        metricName: "http.server.duration",
      });
    });

    it("prices the models called over the window and the window before for a cost comparison", async () => {
      const { app, dependencies } = routes();

      const response = await post(app, {
        config: {
          aggregation: "sum",
          compare: "previous_period",
          display: "number",
          field: "ai:cost",
          filter: { resourceAttrs: [{ key: "span.app.customer.id", value: "acme" }] },
          source: "traces",
        },
        range: "1h",
        type: "timeseries_count",
      });

      expect(response.status).toBe(200);
      const window = { since: "2026-10-13T10:00:00.000Z", until: "2026-10-13T12:00:00.000Z" };
      expect(dependencies.aiModels).toHaveBeenCalledWith(expect.anything(), organizationId, window, {
        filters: [{ key: "span.app.customer.id", value: "acme" }],
        limit: 10_000,
      });
      expect(dependencies.aiPriceOverrides).toHaveBeenCalledWith(organizationId);
      expect(dependencies.resolveAiPrices).toHaveBeenCalledWith(expect.any(Array), window, []);
      expect(dependencies.eventAggregate).toHaveBeenCalledWith(
        expect.anything(),
        organizationId,
        "traces",
        expect.anything(),
        { aggregation: "sum", field: "ai:cost" },
        undefined,
        1,
        expect.objectContaining({ aiPriceKey: ["openai|gpt-5-2025-08-07|"] }),
      );
    });

    it("reads no prices for widgets that do not show cost", async () => {
      const { app, dependencies } = routes();

      await post(app, {
        config: { aggregation: "sum", field: "ai:tokens.output", source: "traces" },
        range: "1h",
        type: "timeseries_count",
      });

      expect(dependencies.aiModels).not.toHaveBeenCalled();
      expect(dependencies.eventSeries).toHaveBeenCalledWith(
        expect.anything(),
        organizationId,
        "traces",
        expect.anything(),
        { aggregation: "sum", field: "ai:tokens.output" },
        undefined,
        expect.anything(),
        undefined,
      );
    });

    it("lists logs and traces for table widgets", async () => {
      const { app, dependencies } = routes();

      expect(
        await (await post(app, { config: { limit: 20 }, range: "15m", type: "log_table" })).json(),
      ).toEqual({ kind: "logs", logs: [{ body: "hello", service: "checkout" }] });
      expect(dependencies.queryLogs).toHaveBeenCalledWith(expect.anything(), organizationId, {
        limit: 20,
        range: expect.anything(),
        resourceAttrs: [],
      });

      await post(app, { config: { limit: 500 }, range: "15m", type: "trace_table" });
      expect(dependencies.queryTraces).toHaveBeenCalledWith(expect.anything(), organizationId, {
        limit: 200,
        range: expect.anything(),
        resourceAttrs: [],
      });
    });

    it("needs the dashboards capability", async () => {
      const { app, dependencies } = routes({ hasDashboards: vi.fn(async () => false) });

      expect((await post(app, { config: {}, range: "1h", type: "log_table" })).status).toBe(404);
      expect(dependencies.queryLogs).not.toHaveBeenCalled();
      expect(dependencies.hasDashboards).toHaveBeenCalledWith(organizationId);
    });

    it("rejects notes and invalid configs", async () => {
      const { app } = routes();

      expect((await post(app, { config: {}, range: "1h", type: "markdown" })).status).toBe(400);
      expect(
        (await post(app, { config: { chartType: "pie" }, range: "1h", type: "timeseries_count" })).status,
      ).toBe(400);
    });
  });

  describe("metrics explorer", () => {
    function series(app: ReturnType<typeof routes>["app"], body: unknown) {
      return app.request("/metric-series", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    }

    it("lists the metric catalog and one metric's dimensions", async () => {
      const { app, dependencies } = routes();

      const catalog = await app.request("/metric-catalog?range=6h");
      expect((await catalog.json()).metrics).toHaveLength(1);
      expect(dependencies.metricCatalog).toHaveBeenCalledWith(expect.anything(), organizationId, {
        since: "2026-10-13T06:00:00.000Z",
        until: "2026-10-13T12:00:00.000Z",
      });

      const dimensions = await app.request(
        `/metric-dimensions?name=http.server.duration&kind=histogram`,
      );
      expect((await dimensions.json()).dimensions).toHaveLength(1);
      expect(dependencies.metricDimensions).toHaveBeenCalledWith(
        expect.anything(),
        organizationId,
        { kind: "histogram", name: "http.server.duration" },
        { since: "2026-10-13T11:00:00.000Z", until: "2026-10-13T12:00:00.000Z" },
      );

      const unknownKind = await app.request("/metric-dimensions?name=a&kind=counter");
      expect(unknownKind.status).toBe(400);
    });

    it("charts a metric with filters and grouping without the dashboards capability", async () => {
      const { app, dependencies } = routes({ hasDashboards: vi.fn(async () => false) });

      const response = await series(app, {
        aggregation: "p95",
        filters: [{ key: "attr:http.route", value: "POST /checkout" }],
        groupBy: "resource.service.name",
        kind: "histogram",
        metricName: "http.server.duration",
        range: "1h",
        unit: "s",
      });

      expect(response.status).toBe(200);
      const { chart } = await response.json();
      expect(chart.series).toEqual([expect.objectContaining({ name: "(none)", other: false })]);
      expect(dependencies.metricSeries).toHaveBeenCalledWith(expect.anything(), organizationId, {
        aggregation: "p95",
        filter: {
          range: { since: "2026-10-13T11:00:00.000Z", until: "2026-10-13T12:00:00.000Z" },
          resourceAttrs: [{ key: "attr:http.route", value: "POST /checkout" }],
        },
        groupBy: "resource.service.name",
        kind: "histogram",
        metricName: "http.server.duration",
        step: expect.anything(),
        unit: "s",
      });
    });

    it("rejects invalid metric queries", async () => {
      const { app } = routes();

      expect((await series(app, { metricName: "", range: "1h" })).status).toBe(400);
      expect((await series(app, { aggregation: "median", metricName: "a", range: "1h" })).status).toBe(400);
    });
  });

  it("hides telemetry from a workspace without the capability or a configured store", async () => {
    for (const overrides of [
      { hasTelemetry: vi.fn(async () => false) },
      { client: () => null },
    ]) {
      const { app, dependencies } = routes(overrides);

      expect((await app.request("/status")).status).toBe(404);
      expect((await app.request("/logs")).status).toBe(404);
      expect(dependencies.queryLogs).not.toHaveBeenCalled();
    }
  });

  it("rejects unknown ranges and oversized limits", async () => {
    const { app } = routes();

    for (const query of ["range=90d", "limit=5000"]) {
      expect((await app.request(`/logs?${query}`)).status).toBe(400);
    }
  });

  it("passes the tenant failure through", async () => {
    const { app } = routes({
      tenant: vi.fn(async () => ({ error: "Unauthorized", ok: false as const, status: 401 as const })),
    });

    expect((await app.request("/status")).status).toBe(401);
  });

  describe("model prices", () => {
    it("lists the models called with their prices, leaving unpriced models without one", async () => {
      const { app } = routes();

      const response = await app.request("/ai-models?range=24h");

      expect(await response.json()).toEqual({
        callsWithoutUsage: 3,
        models: [
          {
            calls: 40,
            inputTokens: 90_000,
            model: "gpt-5-2025-08-07",
            outputTokens: 12_000,
            price: {
              card: { cacheRead: 0.125, cacheWrite: 1.25, input: 1.25, long: null, output: 10, threshold: null },
              catalogModel: "gpt-5",
              source: "catalogue",
            },
            provider: "openai",
            tier: "",
          },
          { calls: 2, inputTokens: 1_000, model: "ft:gpt-4o:acme", outputTokens: 100, price: null, provider: "openai", tier: "" },
        ],
        overrides: [],
      });
    });

    it("sets and removes a workspace's own price", async () => {
      const { app, dependencies } = routes();

      const saved = await app.request("/ai-price-overrides", {
        body: JSON.stringify({ inputMtok: 2, model: "ft:gpt-4o:acme", outputMtok: 8 }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      expect(saved.status).toBe(200);
      expect(dependencies.saveAiPriceOverride).toHaveBeenCalledWith(organizationId, {
        cacheReadMtok: null,
        cacheWriteMtok: null,
        inputMtok: 2,
        model: "ft:gpt-4o:acme",
        outputMtok: 8,
        provider: "",
      });
      expect(
        (await app.request("/ai-price-overrides", {
          body: JSON.stringify({ inputMtok: -1, model: "x", outputMtok: 1 }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        })).status,
      ).toBe(400);

      const moved = await app.request("/ai-price-overrides/4d0c7c4e-8a51-4c62-9a0b-0f7d2b7f6a11", {
        body: JSON.stringify({ inputMtok: 2, model: "ft:gpt-4o:acme", outputMtok: 8, provider: "azure.ai.openai" }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      expect(moved.status).toBe(200);
      expect(dependencies.updateAiPriceOverride).toHaveBeenCalledWith(
        organizationId,
        "4d0c7c4e-8a51-4c62-9a0b-0f7d2b7f6a11",
        expect.objectContaining({ provider: "azure.ai.openai" }),
      );

      const removed = await app.request("/ai-price-overrides/4d0c7c4e-8a51-4c62-9a0b-0f7d2b7f6a11", { method: "DELETE" });
      expect(removed.status).toBe(204);
      expect(dependencies.deleteAiPriceOverride).toHaveBeenCalledWith(organizationId, "4d0c7c4e-8a51-4c62-9a0b-0f7d2b7f6a11");
    });
  });
});
