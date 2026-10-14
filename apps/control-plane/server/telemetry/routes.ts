import { Hono } from "hono";
import { z } from "zod";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import {
  findTelemetryProject,
  listTelemetryProjects,
  type TelemetryProject,
} from "../../../../packages/core/src/db/telemetry-projects.js";
import {
  getTelemetryClient,
  type TelemetryClient as ClickHouseClient,
} from "../../../../packages/core/src/telemetry/client.js";
import {
  chartSeries,
  dashboardWidgetConfigSchema,
  type ChartData,
  type DashboardWidgetConfig,
  resolveWidgetFilters,
} from "../../../../packages/core/src/telemetry/dashboards.js";
import {
  countAggregate,
  countSeries,
  getTraceDetail,
  listAttributeKeys,
  listAttributeValues,
  listMetricNames,
  listServices,
  metricSeries,
  pickStep,
  queryLogs,
  queryTracesAggregated,
  traceOverview,
  type ResourceAttrFilter,
  type SeriesFilter,
  type Step,
  type TimeRange,
  type TraceOverview,
} from "../../../../packages/core/src/telemetry/query.js";
import { getActiveTenant } from "../tenant.js";

// Read-only access to a workspace's OpenTelemetry data. A workspace sees
// telemetry only with the telemetry capability and a configured store, and
// only for the projects linked to it.
export type TelemetryRouteDependencies = {
  // Attribute keys seen in the window, for filters and grouping.
  attributeKeys: (
    client: ClickHouseClient,
    projectId: string,
    range: TimeRange,
    source: AttributeSource,
  ) => Promise<unknown>;
  // Values seen for one attribute key in the window.
  attributeValues: (
    client: ClickHouseClient,
    projectId: string,
    params: { key: string; prefix?: string; range: TimeRange; source: AttributeSource },
  ) => Promise<unknown>;
  client: () => ClickHouseClient | null;
  // Log or span counts per group over the whole window, largest first.
  countAggregate: (
    client: ClickHouseClient,
    projectId: string,
    source: TelemetrySignal,
    filter: SeriesFilter,
    groupBy: string,
    limit: number,
  ) => Promise<Array<{ group: string; value: number }>>;
  // Log or span counts per bucket and group.
  countSeries: (
    client: ClickHouseClient,
    projectId: string,
    source: TelemetrySignal,
    filter: SeriesFilter,
    groupBy: string | undefined,
    step: Step,
  ) => Promise<Array<{ bucket: string; count: number; group: string }>>;
  findProject: (organizationId: string, projectId: string) => Promise<TelemetryProject | null>;
  hasDashboards: (organizationId: string) => Promise<boolean>;
  hasTelemetry: (organizationId: string) => Promise<boolean>;
  listProjects: (organizationId: string) => Promise<TelemetryProject[]>;
  metricNames: (client: ClickHouseClient, projectId: string, range: TimeRange) => Promise<unknown>;
  // One metric aggregated per bucket and group.
  metricSeries: (
    client: ClickHouseClient,
    projectId: string,
    params: {
      aggregation?: DashboardWidgetConfig["aggregation"];
      filter: { range: TimeRange; resourceAttrs: DashboardWidgetConfig["filter"]["resourceAttrs"] };
      groupBy: string | undefined;
      metricName: string;
      step: Step;
    },
  ) => Promise<Array<{ bucket: string; group: string; value: number }>>;
  // Services that sent the signal in the window, or any signal.
  listServices: (
    client: ClickHouseClient,
    projectId: string,
    range: TimeRange,
    signal: TelemetrySignal | undefined,
  ) => Promise<unknown>;
  now: () => Date;
  queryLogs: (
    client: ClickHouseClient,
    projectId: string,
    params: Parameters<typeof queryLogs>[2],
  ) => Promise<unknown>;
  // A trace's spans and logs.
  queryTrace: (
    client: ClickHouseClient,
    projectId: string,
    traceId: string,
  ) => Promise<{ logs: unknown[]; spans: unknown[] }>;
  // How requests into a service behaved over the window.
  traceOverview: (
    client: ClickHouseClient,
    projectId: string,
    params: Parameters<typeof traceOverview>[2],
  ) => Promise<TraceOverview>;
  // Traces that started in the window, newest first.
  queryTraces: (
    client: ClickHouseClient,
    projectId: string,
    params: Parameters<typeof queryTracesAggregated>[2],
  ) => Promise<unknown>;
  tenant: (
    headers: Headers,
  ) => Promise<
    | { ok: true; organizationId: string }
    | { error: string; ok: false; status: 401 | 403 | 409 }
  >;
};

const defaultDependencies: TelemetryRouteDependencies = {
  attributeKeys: (client, projectId, range, source) => listAttributeKeys(client, projectId, range, source),
  attributeValues: (client, projectId, params) =>
    listAttributeValues(client, projectId, params.key, params.range, 200, params.source, params.prefix),
  client: getTelemetryClient,
  countAggregate,
  countSeries,
  findProject: findTelemetryProject,
  hasDashboards: (organizationId) => organizationHasCapability(organizationId, "dashboards"),
  hasTelemetry: (organizationId) => organizationHasCapability(organizationId, "telemetry"),
  listProjects: listTelemetryProjects,
  listServices,
  metricNames: listMetricNames,
  metricSeries: (client, projectId, params) =>
    metricSeries(client, projectId, params.metricName, params.filter, params.groupBy, params.step, params.aggregation),
  now: () => new Date(),
  queryLogs,
  queryTrace: async (client, projectId, traceId) => {
    const trace = await getTraceDetail(client, projectId, traceId);
    return { logs: trace.logs as unknown[], spans: trace.spans as unknown[] };
  },
  queryTraces: queryTracesAggregated,
  tenant: getActiveTenant,
  traceOverview,
};

const rangeMinutes = { "15m": 15, "1h": 60, "6h": 360, "24h": 1_440, "7d": 10_080 } as const;
export type TelemetryRange = keyof typeof rangeMinutes;

const windowSchema = z.object({
  projectId: z.uuid(),
  range: z.enum(Object.keys(rangeMinutes) as [TelemetryRange, ...TelemetryRange[]]).default("1h"),
});

const signals = ["logs", "traces"] as const;
export type TelemetrySignal = (typeof signals)[number];

// "all" includes services that only send metrics.
const servicesSchema = windowSchema.extend({
  signal: z.enum([...signals, "all"]).default("logs"),
});

// Shortest total duration, in milliseconds, up to one hour.
const traceFilterSchema = windowSchema.extend({
  minDurationMs: z.coerce.number().min(0).max(3_600_000).optional(),
});

const tracesSchema = traceFilterSchema.extend({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const overviewSchema = windowSchema.extend({ service: z.string().trim().max(200).optional() });

const traceSchema = z.object({ projectId: z.uuid() });

const attributeSources = ["logs", "traces", "metrics"] as const;
export type AttributeSource = (typeof attributeSources)[number];

const attributeKeysSchema = windowSchema.extend({ source: z.enum(attributeSources).default("logs") });
const attributeValuesSchema = attributeKeysSchema.extend({
  key: z.string().trim().min(1).max(200),
  prefix: z.string().max(200).optional(),
});

const widgetDataSchema = z.object({
  config: dashboardWidgetConfigSchema,
  projectId: z.uuid(),
  range: windowSchema.shape.range,
  type: z.enum(["timeseries_count", "timeseries_metric", "log_table", "trace_table"]),
  // Selected dashboard variable values, substituted into filter values.
  variables: z.record(z.string().max(60), z.string().max(500)).default({}),
});

export type WidgetData =
  | { chart: ChartData; kind: "chart" }
  | { kind: "logs"; logs: unknown }
  | { kind: "traces"; traces: unknown };

const stepMilliseconds = { DAY: 86_400_000, HOUR: 3_600_000, MINUTE: 60_000, SECOND: 1_000 } as const;
const traceIdPattern = /^[0-9a-f]{32}$/u;

const logFilterSchema = windowSchema.extend({
  search: z.string().trim().max(200).optional(),
});

const logsSchema = logFilterSchema.extend({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// Attribute filters arrive as repeated `filter` parameters, such as
// `log.http.status_code=500` or `resource.deployment.environment!=staging`.
// A key without a scope is a resource attribute.
const attributeFilterPattern = /^([^=!]{1,200})(!?=)(.{0,500})$/su;
const maxAttributeFilters = 20;

export function parseAttributeFilters(values: string[]): ResourceAttrFilter[] | null {
  if (values.length > maxAttributeFilters) return null;
  const filters: ResourceAttrFilter[] = [];
  for (const value of values) {
    const match = attributeFilterPattern.exec(value);
    const key = match?.[1]?.trim();
    if (!match || !key) return null;
    filters.push({ key, op: match[2] === "!=" ? "neq" : "eq", value: match[3] ?? "" });
  }
  return filters;
}

// Repeated parameters that match any of their values, and the filter field
// each one sets. `status=error` is the trace list's older form of
// `status=STATUS_CODE_ERROR`.
const valueListParams = {
  logs: { service: "services", severity: "severities" },
  traces: { operation: "spanNames", service: "services", status: "statusCodes" },
} as const satisfies Record<TelemetrySignal, Record<string, keyof SeriesFilter>>;
const maxListValues = 50;
const spanStatusCodes = new Set(["STATUS_CODE_ERROR", "STATUS_CODE_OK", "STATUS_CODE_UNSET"]);

export function parseValueLists(
  signal: TelemetrySignal,
  queries: (name: string) => string[] | undefined,
): Pick<SeriesFilter, "services" | "severities" | "spanNames" | "statusCodes"> | null {
  const lists: Pick<SeriesFilter, "services" | "severities" | "spanNames" | "statusCodes"> = {};
  for (const [param, field] of Object.entries(valueListParams[signal])) {
    const values = [...new Set((queries(param) ?? []).map((value) => value.trim()).filter(Boolean))].map((value) =>
      param === "status" && value === "error" ? "STATUS_CODE_ERROR" : value,
    );
    if (values.length > maxListValues || values.some((value) => value.length > 500)) return null;
    if (param === "status" && values.some((value) => !spanStatusCodes.has(value))) return null;
    if (values.length) lists[field] = values;
  }
  return lists;
}

// Attribute keys shown as extra facets, and the values listed per facet.
const maxFacetKeys = 5;
const facetLimit = 20;

function windowFor(range: TelemetryRange, now: Date): Required<TimeRange> {
  return {
    since: new Date(now.getTime() - rangeMinutes[range] * 60_000).toISOString(),
    until: now.toISOString(),
  };
}

export function createTelemetryRoutes(
  dependencies: TelemetryRouteDependencies = defaultDependencies,
) {
  // The workspace's ID and store, or why the request is refused.
  async function access(headers: Headers): Promise<
    | { client: ClickHouseClient; ok: true; organizationId: string }
    | { error: string; ok: false; status: 401 | 403 | 404 | 409 }
  > {
    const tenant = await dependencies.tenant(headers);
    if (tenant.ok === false) return { error: tenant.error, ok: false, status: tenant.status };
    const client = dependencies.client();
    if (!client || !(await dependencies.hasTelemetry(tenant.organizationId))) {
      return { error: "Telemetry is not available", ok: false, status: 404 };
    }
    return { client, ok: true, organizationId: tenant.organizationId };
  }

  type ExplorerFilter = SeriesFilter & { range: Required<TimeRange>; resourceAttrs: ResourceAttrFilter[] };
  type QueryRequest = { queries: (name: string) => string[] | undefined; query: () => Record<string, string>; raw: Request };

  // An explorer query on a linked project: its window, the filters every
  // explorer endpoint shares, and the endpoint's own parameters.
  async function explorerRequest<Query extends z.infer<typeof windowSchema>>(
    request: QueryRequest,
    signal: TelemetrySignal,
    schema: z.ZodType<Query>,
  ): Promise<
    | { client: ClickHouseClient; filter: ExplorerFilter; ok: true; query: Query }
    | { error: string; ok: false; status: 400 | 401 | 403 | 404 | 409 }
  > {
    const granted = await access(request.raw.headers);
    if (!granted.ok) return granted;
    const query = schema.safeParse(request.query());
    const attrs = parseAttributeFilters(request.queries("filter") ?? []);
    const lists = parseValueLists(signal, (name) => request.queries(name));
    if (!query.success || !attrs || !lists) {
      return { error: `Invalid ${signal === "logs" ? "log" : "trace"} query`, ok: false, status: 400 };
    }
    if (!(await dependencies.findProject(granted.organizationId, query.data.projectId))) {
      return { error: "Telemetry project not found", ok: false, status: 404 };
    }
    const options = query.data as { minDurationMs?: number; search?: string };
    return {
      client: granted.client,
      filter: {
        range: windowFor(query.data.range, dependencies.now()),
        resourceAttrs: attrs,
        ...lists,
        ...(options.search ? { search: options.search } : {}),
        // A trace's total duration, as the trace list filters it.
        ...(options.minDurationMs ? { minTraceDurationMs: options.minDurationMs } : {}),
      },
      ok: true,
      query: query.data,
    };
  }

  // Matching logs or spans per bucket and group, for an explorer's count chart.
  async function histogram(
    request: { client: ClickHouseClient; filter: ExplorerFilter; query: z.infer<typeof windowSchema> },
    signal: TelemetrySignal,
    groupBy: string,
  ) {
    const step = pickStep(rangeMinutes[request.query.range] * 60);
    const buckets = await dependencies.countSeries(
      request.client,
      request.query.projectId,
      signal,
      request.filter,
      groupBy,
      step,
    );
    return {
      buckets,
      since: request.filter.range.since,
      stepMs: step.n * stepMilliseconds[step.unit],
      until: request.filter.range.until,
    };
  }

  // Counts per value of each facet. A facet ignores its own filter, so its
  // other values stay listed and can be added.
  function facet(
    request: { client: ClickHouseClient; filter: ExplorerFilter; query: z.infer<typeof windowSchema> },
    signal: TelemetrySignal,
    groupBy: string,
    without: Partial<ExplorerFilter>,
  ) {
    return dependencies.countAggregate(
      request.client,
      request.query.projectId,
      signal,
      { ...request.filter, ...without },
      groupBy,
      facetLimit,
    );
  }

  // Extra facets over attribute keys, each ignoring filters on its own key.
  function attributeFacets(
    request: { client: ClickHouseClient; filter: ExplorerFilter; query: z.infer<typeof windowSchema> },
    signal: TelemetrySignal,
    keys: string[],
  ): Promise<Record<string, Array<{ group: string; value: number }>>> {
    return Promise.all(
      keys.map(async (key) => [
        key,
        await facet(request, signal, key, {
          resourceAttrs: request.filter.resourceAttrs.filter((filter) => filter.key !== key),
        }),
      ] as const),
    ).then(Object.fromEntries);
  }

  function facetKeys(request: QueryRequest): string[] | null {
    const keys = [...new Set((request.queries("facet") ?? []).map((key) => key.trim()).filter(Boolean))];
    return keys.length > maxFacetKeys || keys.some((key) => key.length > 200) ? null : keys;
  }

  return new Hono()
    .get("/projects", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      return context.json({ projects: await dependencies.listProjects(granted.organizationId) });
    })
    .get("/logs", async (context) => {
      const request = await explorerRequest(context.req, "logs", logsSchema);
      if (!request.ok) return context.json({ error: request.error }, request.status);
      const { filter } = request;
      const logs = await dependencies.queryLogs(request.client, request.query.projectId, {
        limit: request.query.limit,
        range: filter.range,
        ...(filter.resourceAttrs.length ? { resourceAttrs: filter.resourceAttrs } : {}),
        ...(filter.search ? { search: filter.search } : {}),
        ...(filter.services ? { services: filter.services } : {}),
        ...(filter.severities ? { severities: filter.severities } : {}),
      });
      return context.json({ logs });
    })
    // Matching logs per bucket and level.
    .get("/logs/histogram", async (context) => {
      const request = await explorerRequest(context.req, "logs", logFilterSchema);
      if (!request.ok) return context.json({ error: request.error }, request.status);
      return context.json(await histogram(request, "logs", "severity"));
    })
    .get("/logs/facets", async (context) => {
      const keys = facetKeys(context.req);
      const request = await explorerRequest(context.req, "logs", logFilterSchema);
      if (!request.ok) return context.json({ error: request.error }, request.status);
      if (!keys) return context.json({ error: "Invalid log query" }, 400);
      const [severities, services, attributes] = await Promise.all([
        facet(request, "logs", "severity", { severities: undefined }),
        facet(request, "logs", "service", { services: undefined }),
        attributeFacets(request, "logs", keys),
      ]);
      return context.json({ attributes, services, severities });
    })
    .get("/services", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const query = servicesSchema.safeParse(context.req.query());
      if (!query.success) return context.json({ error: "Invalid service query" }, 400);
      if (!(await dependencies.findProject(granted.organizationId, query.data.projectId))) {
        return context.json({ error: "Telemetry project not found" }, 404);
      }
      return context.json({
        services: await dependencies.listServices(
          granted.client,
          query.data.projectId,
          windowFor(query.data.range, dependencies.now()),
          query.data.signal === "all" ? undefined : query.data.signal,
        ),
      });
    })
    .get("/traces", async (context) => {
      const request = await explorerRequest(context.req, "traces", tracesSchema);
      if (!request.ok) return context.json({ error: request.error }, request.status);
      const { filter } = request;
      const traces = await dependencies.queryTraces(request.client, request.query.projectId, {
        limit: request.query.limit,
        range: filter.range,
        ...(filter.resourceAttrs.length ? { resourceAttrs: filter.resourceAttrs } : {}),
        ...(filter.minTraceDurationMs ? { minDurationMs: filter.minTraceDurationMs } : {}),
        ...(filter.services ? { services: filter.services } : {}),
        ...(filter.spanNames ? { spanNames: filter.spanNames } : {}),
        ...(filter.statusCodes ? { statusCodes: filter.statusCodes } : {}),
      });
      return context.json({ traces });
    })
    // Matching spans per bucket and status.
    .get("/traces/histogram", async (context) => {
      const request = await explorerRequest(context.req, "traces", traceFilterSchema);
      if (!request.ok) return context.json({ error: request.error }, request.status);
      return context.json(await histogram(request, "traces", "status"));
    })
    .get("/traces/facets", async (context) => {
      const keys = facetKeys(context.req);
      const request = await explorerRequest(context.req, "traces", traceFilterSchema);
      if (!request.ok) return context.json({ error: request.error }, request.status);
      if (!keys) return context.json({ error: "Invalid trace query" }, 400);
      const [statuses, services, operations, attributes] = await Promise.all([
        facet(request, "traces", "status", { statusCodes: undefined }),
        facet(request, "traces", "service", { services: undefined }),
        facet(request, "traces", "operation", { spanNames: undefined }),
        attributeFacets(request, "traces", keys),
      ]);
      return context.json({ attributes, operations, services, statuses });
    })
    // How requests into a service behaved over the window.
    .get("/traces/overview", async (context) => {
      const request = await explorerRequest(context.req, "traces", overviewSchema);
      if (!request.ok) return context.json({ error: request.error }, request.status);
      const step = pickStep(rangeMinutes[request.query.range] * 60);
      const overview = await dependencies.traceOverview(request.client, request.query.projectId, {
        range: request.filter.range,
        step,
        ...(request.filter.resourceAttrs.length ? { resourceAttrs: request.filter.resourceAttrs } : {}),
        ...(request.query.service ? { service: request.query.service } : {}),
      });
      return context.json({
        overview,
        since: request.filter.range.since,
        stepMs: step.n * stepMilliseconds[step.unit],
        until: request.filter.range.until,
      });
    })
    .get("/attribute-keys", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const query = attributeKeysSchema.safeParse(context.req.query());
      if (!query.success) return context.json({ error: "Invalid attribute query" }, 400);
      if (!(await dependencies.findProject(granted.organizationId, query.data.projectId))) {
        return context.json({ error: "Telemetry project not found" }, 404);
      }
      return context.json({
        keys: await dependencies.attributeKeys(
          granted.client,
          query.data.projectId,
          windowFor(query.data.range, dependencies.now()),
          query.data.source,
        ),
      });
    })
    .get("/attribute-values", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const query = attributeValuesSchema.safeParse(context.req.query());
      if (!query.success) return context.json({ error: "Invalid attribute query" }, 400);
      if (!(await dependencies.findProject(granted.organizationId, query.data.projectId))) {
        return context.json({ error: "Telemetry project not found" }, 404);
      }
      return context.json({
        values: await dependencies.attributeValues(granted.client, query.data.projectId, {
          key: query.data.key,
          range: windowFor(query.data.range, dependencies.now()),
          source: query.data.source,
          ...(query.data.prefix ? { prefix: query.data.prefix } : {}),
        }),
      });
    })
    .get("/metric-names", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const query = windowSchema.safeParse(context.req.query());
      if (!query.success) return context.json({ error: "Invalid metric query" }, 400);
      if (!(await dependencies.findProject(granted.organizationId, query.data.projectId))) {
        return context.json({ error: "Telemetry project not found" }, 404);
      }
      return context.json({
        metrics: await dependencies.metricNames(
          granted.client,
          query.data.projectId,
          windowFor(query.data.range, dependencies.now()),
        ),
      });
    })
    // Data for one dashboard widget, saved or still being edited.
    .post("/widget-data", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      if (!(await dependencies.hasDashboards(granted.organizationId))) {
        return context.json({ error: "Dashboards are not available" }, 404);
      }
      const body = widgetDataSchema.safeParse(await context.req.json().catch(() => null));
      if (!body.success) return context.json({ error: "Invalid widget" }, 400);
      const { config, projectId, type, variables } = body.data;
      if (type === "timeseries_metric" && !config.metricName) {
        return context.json({ error: "Choose a metric" }, 400);
      }
      if (!(await dependencies.findProject(granted.organizationId, projectId))) {
        return context.json({ error: "Telemetry project not found" }, 404);
      }
      const range = windowFor(body.data.range, dependencies.now());
      const resourceAttrs = resolveWidgetFilters(config.filter.resourceAttrs, variables);
      const limit = config.limit;
      if (type === "log_table") {
        const logs = await dependencies.queryLogs(granted.client, projectId, { limit: limit ?? 50, range, resourceAttrs });
        return context.json({ kind: "logs", logs } satisfies WidgetData);
      }
      if (type === "trace_table") {
        const traces = await dependencies.queryTraces(granted.client, projectId, {
          limit: Math.min(limit ?? 50, 200),
          range,
          resourceAttrs,
        });
        return context.json({ kind: "traces", traces } satisfies WidgetData);
      }
      const sinceMs = Date.parse(range.since);
      const untilMs = Date.parse(range.until);
      const step = pickStep((untilMs - sinceMs) / 1000);
      const window = { limit, sinceMs, stepMs: step.n * stepMilliseconds[step.unit], untilMs };
      const groupBy = config.groupBy || undefined;
      if (type === "timeseries_metric") {
        const rows = await dependencies.metricSeries(granted.client, projectId, {
          ...(config.aggregation ? { aggregation: config.aggregation } : {}),
          filter: { range, resourceAttrs },
          groupBy,
          metricName: config.metricName!,
          step,
        });
        return context.json({ chart: chartSeries(rows, { ...window, fill: "null" }), kind: "chart" } satisfies WidgetData);
      }
      const rows = await dependencies.countSeries(
        granted.client,
        projectId,
        config.source ?? "logs",
        { range, resourceAttrs },
        groupBy,
        step,
      );
      const values = rows.map((row) => ({ bucket: row.bucket, group: row.group, value: row.count }));
      return context.json({ chart: chartSeries(values, { ...window, fill: "zero" }), kind: "chart" } satisfies WidgetData);
    })
    .get("/traces/:traceId", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const query = traceSchema.safeParse(context.req.query());
      const traceId = context.req.param("traceId").toLowerCase();
      if (!query.success || !traceIdPattern.test(traceId)) {
        return context.json({ error: "Invalid trace" }, 400);
      }
      if (!(await dependencies.findProject(granted.organizationId, query.data.projectId))) {
        return context.json({ error: "Telemetry project not found" }, 404);
      }
      const trace = await dependencies.queryTrace(granted.client, query.data.projectId, traceId);
      if (trace.spans.length === 0) return context.json({ error: "Trace not found" }, 404);
      return context.json(trace);
    });
}
