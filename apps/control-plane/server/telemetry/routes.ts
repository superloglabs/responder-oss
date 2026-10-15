import { Hono } from "hono";
import { z } from "zod";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import {
  deleteAiPriceOverride,
  listAiPriceOverrides,
  saveAiPriceOverride,
  type AiModelPriceOverride,
} from "../../../../packages/core/src/db/ai-model-prices.js";
import {
  findTelemetryProject,
  listTelemetryProjects,
  type TelemetryProject,
} from "../../../../packages/core/src/db/telemetry-projects.js";
import {
  resolveAiPrices,
  startAiPriceUpdates,
  type AiPriceOverride,
  type AiPriceParams,
} from "../../../../packages/core/src/telemetry/ai-cost.js";
import {
  getTelemetryClient,
  type TelemetryClient as ClickHouseClient,
} from "../../../../packages/core/src/telemetry/client.js";
import {
  chartSeries,
  dashboardWidgetConfigSchema,
  maxWidgetFilters,
  metricAggregations,
  type ChartData,
  type ResolvedWidgetFilter,
  resolveWidgetFilters,
  widgetConfigProblem,
} from "../../../../packages/core/src/telemetry/dashboards.js";
import {
  aiCallsWithoutUsage,
  aiModelsInWindow,
  countAggregate,
  countSeries,
  eventAggregate,
  eventSeries,
  getTraceDetail,
  isAdditiveAggregation,
  listAttributeKeys,
  listAttributeValues,
  listMetricCatalog,
  listMetricDimensions,
  listMetricNames,
  listServices,
  metricSeries,
  metricWindowAggregate,
  pickStep,
  queryLogs,
  queryTracesAggregated,
  traceOverview,
  type AiModelUsage,
  type EventMeasure,
  type MetricAggregation,
  type MetricKind,
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
  // Model calls in the window whose spans report no token counts.
  aiCallsWithoutUsage: (client: ClickHouseClient, projectId: string, range: TimeRange) => Promise<number>;
  // The models called in the window, most called first.
  aiModels: (client: ClickHouseClient, projectId: string, range: TimeRange) => Promise<AiModelUsage[]>;
  // The workspace's own model prices.
  aiPriceOverrides: (organizationId: string) => Promise<AiModelPriceOverride[]>;
  deleteAiPriceOverride: (organizationId: string, id: string) => Promise<boolean>;
  // Each model's price over the window, as query parameters and for display.
  resolveAiPrices: typeof resolveAiPrices;
  saveAiPriceOverride: (organizationId: string, price: AiPriceOverride) => Promise<AiModelPriceOverride>;
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
    params: { filters?: ResourceAttrFilter[]; key: string; prefix?: string; range: TimeRange; source: AttributeSource },
  ) => Promise<unknown>;
  client: () => ClickHouseClient | null;
  // Log or span counts per group over the whole window, largest first.
  countAggregate: (
    client: ClickHouseClient,
    projectId: string,
    source: TelemetrySignal,
    filter: SeriesFilter,
    groupBy: string | undefined,
    limit: number,
  ) => Promise<Array<{ group: string; value: number }>>;
  // Logs or spans summed up from a field, per group over the whole window,
  // largest first.
  eventAggregate: (
    client: ClickHouseClient,
    projectId: string,
    source: TelemetrySignal,
    filter: SeriesFilter,
    measure: EventMeasure,
    groupBy: string | undefined,
    limit: number,
    aiPrices?: AiPriceParams,
  ) => Promise<Array<{ group: string; value: number }>>;
  // Logs or spans summed up from a field, per bucket and group.
  eventSeries: (
    client: ClickHouseClient,
    projectId: string,
    source: TelemetrySignal,
    filter: SeriesFilter,
    measure: EventMeasure,
    groupBy: string | undefined,
    step: Step,
    aiPrices?: AiPriceParams,
  ) => Promise<Array<{ bucket: string; group: string; value: number }>>;
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
  // Every metric in the window, with its description, services and attributes.
  metricCatalog: (client: ClickHouseClient, projectId: string, range: TimeRange) => Promise<unknown>;
  // The attributes one metric carries and their most frequent values.
  metricDimensions: (
    client: ClickHouseClient,
    projectId: string,
    metric: { kind: MetricKind; name: string; unit?: string },
    range: TimeRange,
  ) => Promise<unknown>;
  metricNames: (client: ClickHouseClient, projectId: string, range: TimeRange) => Promise<unknown>;
  // One metric aggregated per bucket and group.
  metricSeries: (
    client: ClickHouseClient,
    projectId: string,
    params: {
      aggregation?: MetricAggregation;
      filter: { range: TimeRange; resourceAttrs: ResolvedWidgetFilter[] };
      groupBy: string | undefined;
      kind?: MetricKind;
      metricName: string;
      step: Step;
      unit?: string;
    },
  ) => Promise<Array<{ bucket: string; group: string; value: number }>>;
  // One metric per group over the whole window, largest first.
  metricWindowAggregate: (
    client: ClickHouseClient,
    projectId: string,
    params: {
      aggregation?: MetricAggregation;
      filter: { range: TimeRange; resourceAttrs: ResolvedWidgetFilter[] };
      groupBy: string | undefined;
      kind?: MetricKind;
      limit: number;
      metricName: string;
      unit?: string;
    },
  ) => Promise<Array<{ group: string; value: number }>>;
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
  aiCallsWithoutUsage: (client, projectId, range) => aiCallsWithoutUsage(client, projectId, { range }),
  aiModels: (client, projectId, range) => aiModelsInWindow(client, projectId, { range }),
  aiPriceOverrides: listAiPriceOverrides,
  deleteAiPriceOverride,
  resolveAiPrices: (models, window, overrides) => {
    startAiPriceUpdates();
    return resolveAiPrices(models, window, overrides);
  },
  saveAiPriceOverride,
  attributeKeys: (client, projectId, range, source) => listAttributeKeys(client, projectId, range, source),
  attributeValues: (client, projectId, params) =>
    listAttributeValues(client, projectId, params.key, params.range, 200, params.source, params.prefix, params.filters),
  client: getTelemetryClient,
  countAggregate,
  countSeries,
  eventAggregate,
  eventSeries,
  findProject: findTelemetryProject,
  hasDashboards: (organizationId) => organizationHasCapability(organizationId, "dashboards"),
  hasTelemetry: (organizationId) => organizationHasCapability(organizationId, "telemetry"),
  listProjects: listTelemetryProjects,
  listServices,
  metricCatalog: listMetricCatalog,
  metricDimensions: listMetricDimensions,
  metricNames: listMetricNames,
  metricSeries: (client, projectId, params) =>
    metricSeries(
      client,
      projectId,
      params.metricName,
      params.filter,
      params.groupBy,
      params.step,
      params.aggregation,
      {
        ...(params.kind ? { kind: params.kind } : {}),
        ...(params.unit !== undefined ? { unit: params.unit } : {}),
      },
    ),
  metricWindowAggregate: (client, projectId, params) =>
    metricWindowAggregate(
      client,
      projectId,
      params.metricName,
      params.filter,
      params.groupBy,
      params.aggregation,
      params.limit,
      {
        ...(params.kind ? { kind: params.kind } : {}),
        ...(params.unit !== undefined ? { unit: params.unit } : {}),
      },
    ),
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

// A query covers the last `range`, or the window from `since` to `until`.
const windowSchema = z.object({
  projectId: z.uuid(),
  range: z.enum(Object.keys(rangeMinutes) as [TelemetryRange, ...TelemetryRange[]]).default("1h"),
  since: z.iso.datetime().optional(),
  until: z.iso.datetime().optional(),
});
// The longest window a query may cover, with a minute to spare for a
// 30-day range resolved a moment before the request.
const maximumWindowMs = 30 * 86_400_000 + 60_000;

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
const filterValuesSchema = z.object({
  key: z.string().trim().min(1).max(200),
  op: z.enum(["eq", "neq", "not_contains"]).optional(),
  value: z.string().max(500),
  values: z.array(z.string().max(500)).min(1).max(200).optional(),
});
const attributeValuesSchema = attributeKeysSchema.extend({
  // Other filters, as JSON: [{ key, value, values? }].
  filters: z
    .string()
    .max(20_000)
    .optional()
    .transform((text, context) => {
      if (!text) return undefined;
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      const parsed = z.array(filterValuesSchema).max(50).safeParse(json);
      if (parsed.success) return parsed.data;
      context.addIssue({ code: "custom", message: "Invalid filters" });
      return z.NEVER;
    }),
  key: z.string().trim().min(1).max(200),
  prefix: z.string().max(200).optional(),
});

const metricKinds = ["gauge", "sum", "histogram", "exponential_histogram", "summary"] as const satisfies readonly MetricKind[];

// A metric is a name, kind and unit; without a unit every unit is read.
const metricUnitSchema = z.string().max(100).optional();

const metricDimensionsSchema = windowSchema.extend({
  kind: z.enum(metricKinds),
  name: z.string().trim().min(1).max(200),
  unit: metricUnitSchema,
});

// One metric over the window, for the metrics explorer.
const metricSeriesSchema = z.object({
  aggregation: z.enum(metricAggregations).optional(),
  // `attr:<key>` keys are data-point attributes; others are resource attributes.
  filters: z.array(z.object({
    key: z.string().trim().min(1).max(200),
    op: z.enum(["eq", "neq", "not_contains"]).optional(),
    value: z.string().max(500),
  })).max(maxWidgetFilters).default([]),
  groupBy: z.string().trim().max(200).optional(),
  kind: z.enum(metricKinds).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  metricName: z.string().trim().min(1).max(200),
  projectId: z.uuid(),
  range: windowSchema.shape.range,
  since: windowSchema.shape.since,
  unit: metricUnitSchema,
  until: windowSchema.shape.until,
});

// USD per million tokens.
const tokenPrice = z.number().finite().min(0).max(100_000);
const aiPriceOverrideSchema = z.object({
  cacheReadMtok: tokenPrice.nullable().optional(),
  cacheWriteMtok: tokenPrice.nullable().optional(),
  inputMtok: tokenPrice,
  model: z.string().trim().min(1).max(200),
  outputMtok: tokenPrice,
  provider: z.string().trim().max(100).default(""),
});

const widgetDataSchema = z.object({
  config: dashboardWidgetConfigSchema,
  projectId: z.uuid(),
  range: windowSchema.shape.range,
  since: windowSchema.shape.since,
  type: z.enum(["timeseries_count", "timeseries_metric", "log_table", "trace_table"]),
  until: windowSchema.shape.until,
  // Selected dashboard variable values, substituted into filter values. A
  // multi-value variable sends its selection as a list.
  variables: z
    .record(z.string().max(60), z.union([z.string().max(500), z.array(z.string().max(500)).max(200)]))
    .default({}),
});

// A number or group also carries its value over the window before, when the
// widget compares with it. Null means nothing had a value.
export type WidgetValueRow = { group: string; previous?: number | null; value: number | null };

export type WidgetData =
  | { chart: ChartData; kind: "chart" }
  | { kind: "logs"; logs: unknown }
  | { kind: "number"; previous?: number | null; value: number | null }
  | { kind: "rows"; rows: WidgetValueRow[] }
  | { kind: "traces"; traces: unknown };

const stepMilliseconds = { DAY: 86_400_000, HOUR: 3_600_000, MINUTE: 60_000, SECOND: 1_000 } as const;
const traceIdPattern = /^[0-9a-f]{32}$/u;

const logFilterSchema = windowSchema.extend({
  search: z.string().trim().max(500).optional(),
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

// About 120 count buckets across the window.
function windowStep(range: Required<TimeRange>): Step {
  return pickStep((Date.parse(range.until) - Date.parse(range.since)) / 1000);
}

function windowFor(
  query: { range: TelemetryRange; since?: string | undefined; until?: string | undefined },
  now: Date,
): Required<TimeRange> | null {
  if (query.since === undefined && query.until === undefined) {
    return {
      since: new Date(now.getTime() - rangeMinutes[query.range] * 60_000).toISOString(),
      until: now.toISOString(),
    };
  }
  if (query.since === undefined || query.until === undefined) return null;
  const since = Date.parse(query.since);
  const until = Date.parse(query.until);
  if (!(until > since) || until - since > maximumWindowMs) return null;
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
}

// The window of the same length that ends where this one starts.
function previousWindow(range: Required<TimeRange>): Required<TimeRange> {
  const since = Date.parse(range.since);
  const length = Date.parse(range.until) - since;
  return { since: new Date(since - length).toISOString(), until: new Date(since).toISOString() };
}

export function createTelemetryRoutes(
  dependencies: TelemetryRouteDependencies = defaultDependencies,
) {
  // One metric per bucket and group, with every bucket in the window.
  async function metricChart(
    client: ClickHouseClient,
    projectId: string,
    query: {
      aggregation?: MetricAggregation;
      filters: ResolvedWidgetFilter[];
      groupBy: string | undefined;
      kind?: MetricKind;
      limit: number | undefined;
      metricName: string;
      range: Required<TimeRange>;
      unit?: string;
    },
  ): Promise<ChartData> {
    const { range } = query;
    const sinceMs = Date.parse(range.since);
    const untilMs = Date.parse(range.until);
    const step = pickStep((untilMs - sinceMs) / 1000);
    const rows = await dependencies.metricSeries(client, projectId, {
      ...(query.aggregation ? { aggregation: query.aggregation } : {}),
      filter: { range, resourceAttrs: query.filters },
      groupBy: query.groupBy,
      ...(query.kind ? { kind: query.kind } : {}),
      metricName: query.metricName,
      step,
      ...(query.unit !== undefined ? { unit: query.unit } : {}),
    });
    return chartSeries(rows, {
      fill: "null",
      limit: query.limit,
      other: isAdditiveAggregation(query.aggregation),
      sinceMs,
      stepMs: step.n * stepMilliseconds[step.unit],
      untilMs,
    });
  }

  // Prices of the models called in the window, with the workspace's own.
  async function aiPriceParams(
    client: ClickHouseClient,
    organizationId: string,
    projectId: string,
    range: Required<TimeRange>,
  ) {
    const [models, overrides] = await Promise.all([
      dependencies.aiModels(client, projectId, range),
      dependencies.aiPriceOverrides(organizationId),
    ]);
    return dependencies.resolveAiPrices(models, range, overrides).params;
  }

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
    const range = windowFor(query.data, dependencies.now());
    if (!range) return { error: `Invalid ${signal === "logs" ? "log" : "trace"} query`, ok: false, status: 400 };
    const options = query.data as { minDurationMs?: number; search?: string };
    return {
      client: granted.client,
      filter: {
        range,
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
    const step = windowStep(request.filter.range);
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
      const timeWindow = windowFor(query.data, dependencies.now());
      if (!timeWindow) return context.json({ error: "Invalid service query" }, 400);
      if (!(await dependencies.findProject(granted.organizationId, query.data.projectId))) {
        return context.json({ error: "Telemetry project not found" }, 404);
      }
      return context.json({
        services: await dependencies.listServices(
          granted.client,
          query.data.projectId,
          timeWindow,
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
      const step = windowStep(request.filter.range);
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
      const timeWindow = windowFor(query.data, dependencies.now());
      if (!timeWindow) return context.json({ error: "Invalid attribute query" }, 400);
      if (!(await dependencies.findProject(granted.organizationId, query.data.projectId))) {
        return context.json({ error: "Telemetry project not found" }, 404);
      }
      return context.json({
        keys: await dependencies.attributeKeys(
          granted.client,
          query.data.projectId,
          timeWindow,
          query.data.source,
        ),
      });
    })
    .get("/attribute-values", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const query = attributeValuesSchema.safeParse(context.req.query());
      if (!query.success) return context.json({ error: "Invalid attribute query" }, 400);
      const timeWindow = windowFor(query.data, dependencies.now());
      if (!timeWindow) return context.json({ error: "Invalid attribute query" }, 400);
      if (!(await dependencies.findProject(granted.organizationId, query.data.projectId))) {
        return context.json({ error: "Telemetry project not found" }, 404);
      }
      return context.json({
        values: await dependencies.attributeValues(granted.client, query.data.projectId, {
          key: query.data.key,
          range: timeWindow,
          source: query.data.source,
          ...(query.data.filters ? { filters: query.data.filters } : {}),
          ...(query.data.prefix ? { prefix: query.data.prefix } : {}),
        }),
      });
    })
    .get("/metric-names", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const query = windowSchema.safeParse(context.req.query());
      if (!query.success) return context.json({ error: "Invalid metric query" }, 400);
      const timeWindow = windowFor(query.data, dependencies.now());
      if (!timeWindow) return context.json({ error: "Invalid metric query" }, 400);
      if (!(await dependencies.findProject(granted.organizationId, query.data.projectId))) {
        return context.json({ error: "Telemetry project not found" }, 404);
      }
      return context.json({
        metrics: await dependencies.metricNames(
          granted.client,
          query.data.projectId,
          timeWindow,
        ),
      });
    })
    .get("/metric-catalog", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const query = windowSchema.safeParse(context.req.query());
      const range = query.success ? windowFor(query.data, dependencies.now()) : null;
      if (!query.success || !range) return context.json({ error: "Invalid metric query" }, 400);
      if (!(await dependencies.findProject(granted.organizationId, query.data.projectId))) {
        return context.json({ error: "Telemetry project not found" }, 404);
      }
      return context.json({
        metrics: await dependencies.metricCatalog(granted.client, query.data.projectId, range),
      });
    })
    .get("/metric-dimensions", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const query = metricDimensionsSchema.safeParse(context.req.query());
      const range = query.success ? windowFor(query.data, dependencies.now()) : null;
      if (!query.success || !range) return context.json({ error: "Invalid metric query" }, 400);
      if (!(await dependencies.findProject(granted.organizationId, query.data.projectId))) {
        return context.json({ error: "Telemetry project not found" }, 404);
      }
      return context.json({
        dimensions: await dependencies.metricDimensions(
          granted.client,
          query.data.projectId,
          {
            kind: query.data.kind,
            name: query.data.name,
            ...(query.data.unit !== undefined ? { unit: query.data.unit } : {}),
          },
          range,
        ),
      });
    })
    // Exploring a metric needs telemetry only, not dashboards.
    .post("/metric-series", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const body = metricSeriesSchema.safeParse(await context.req.json().catch(() => null));
      const range = body.success ? windowFor(body.data, dependencies.now()) : null;
      if (!body.success || !range) return context.json({ error: "Invalid metric query" }, 400);
      if (!(await dependencies.findProject(granted.organizationId, body.data.projectId))) {
        return context.json({ error: "Telemetry project not found" }, 404);
      }
      const chart = await metricChart(granted.client, body.data.projectId, {
        ...(body.data.aggregation ? { aggregation: body.data.aggregation } : {}),
        filters: body.data.filters,
        groupBy: body.data.groupBy || undefined,
        ...(body.data.kind ? { kind: body.data.kind } : {}),
        limit: body.data.limit,
        metricName: body.data.metricName,
        range,
        ...(body.data.unit !== undefined ? { unit: body.data.unit } : {}),
      });
      return context.json({ chart });
    })
    // The models called in the window, with the price each call is charged
    // at, and how many calls cannot be priced.
    .get("/ai-models", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const query = windowSchema.safeParse(context.req.query());
      const range = query.success ? windowFor(query.data, dependencies.now()) : null;
      if (!query.success || !range) return context.json({ error: "Invalid query" }, 400);
      if (!(await dependencies.findProject(granted.organizationId, query.data.projectId))) {
        return context.json({ error: "Telemetry project not found" }, 404);
      }
      const [models, overrides, callsWithoutUsage] = await Promise.all([
        dependencies.aiModels(granted.client, query.data.projectId, range),
        dependencies.aiPriceOverrides(granted.organizationId),
        dependencies.aiCallsWithoutUsage(granted.client, query.data.projectId, range),
      ]);
      const { prices } = dependencies.resolveAiPrices(models, range, overrides);
      const key = (model: { model: string; provider: string; tier: string }) => `${model.provider}|${model.model}|${model.tier}`;
      const priced = new Map(prices.map((price) => [key(price), price]));
      return context.json({
        callsWithoutUsage,
        models: models.map((model) => {
          const price = priced.get(key(model));
          return {
            ...model,
            price: price ? { card: price.card, catalogModel: price.catalogModel, source: price.source } : null,
          };
        }),
        overrides,
      });
    })
    .put("/ai-price-overrides", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const body = aiPriceOverrideSchema.safeParse(await context.req.json().catch(() => null));
      if (!body.success) return context.json({ error: "Invalid price" }, 400);
      const override = await dependencies.saveAiPriceOverride(granted.organizationId, {
        cacheReadMtok: body.data.cacheReadMtok ?? null,
        cacheWriteMtok: body.data.cacheWriteMtok ?? null,
        inputMtok: body.data.inputMtok,
        model: body.data.model,
        outputMtok: body.data.outputMtok,
        provider: body.data.provider,
      });
      return context.json({ override });
    })
    .delete("/ai-price-overrides/:id", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const id = z.uuid().safeParse(context.req.param("id"));
      if (!id.success || !(await dependencies.deleteAiPriceOverride(granted.organizationId, id.data))) {
        return context.json({ error: "Price not found" }, 404);
      }
      return context.body(null, 204);
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
      const range = windowFor(body.data, dependencies.now());
      if (!range) return context.json({ error: "Invalid widget" }, 400);
      const { config, projectId, type, variables } = body.data;
      const problem = type === "timeseries_count" || type === "timeseries_metric" ? widgetConfigProblem(type, config) : null;
      if (problem) return context.json({ error: problem.message }, 400);
      if (!(await dependencies.findProject(granted.organizationId, projectId))) {
        return context.json({ error: "Telemetry project not found" }, 404);
      }
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
      const groupBy = config.groupBy || undefined;
      const display = config.display ?? "timeseries";
      const additive = isAdditiveAggregation(config.aggregation);
      const metricAggregation = type === "timeseries_metric" ? (config.aggregation as MetricAggregation | undefined) : undefined;
      const measure: EventMeasure = {
        aggregation: config.aggregation ?? "count",
        ...(config.field ? { field: config.field } : {}),
      };
      const source = config.source ?? "logs";
      const comparing = config.compare === "previous_period" && display !== "timeseries";
      // Cost reads each model's price over the window, and the window before
      // when compared.
      const aiPrices = measure.field === "ai:cost"
        ? await aiPriceParams(
            granted.client,
            granted.organizationId,
            projectId,
            comparing ? { since: previousWindow(range).since, until: range.until } : range,
          )
        : undefined;
      if (display === "timeseries") {
        if (type === "timeseries_metric") {
          const chart = await metricChart(granted.client, projectId, {
            ...(metricAggregation ? { aggregation: metricAggregation } : {}),
            filters: resourceAttrs,
            groupBy,
            ...(config.metricKind ? { kind: config.metricKind } : {}),
            limit,
            metricName: config.metricName!,
            range,
            ...(config.metricUnit !== undefined ? { unit: config.metricUnit } : {}),
          });
          return context.json({ chart, kind: "chart" } satisfies WidgetData);
        }
        const sinceMs = Date.parse(range.since);
        const untilMs = Date.parse(range.until);
        const step = pickStep((untilMs - sinceMs) / 1000);
        const window = { limit, other: additive, sinceMs, stepMs: step.n * stepMilliseconds[step.unit], untilMs };
        const filter = { range, resourceAttrs };
        const rows = measure.aggregation === "count"
          ? (await dependencies.countSeries(granted.client, projectId, source, filter, groupBy, step))
              .map((row) => ({ bucket: row.bucket, group: row.group, value: row.count }))
          : await dependencies.eventSeries(granted.client, projectId, source, filter, measure, groupBy, step, aiPrices);
        return context.json({ chart: chartSeries(rows, { ...window, fill: additive ? "zero" : "null" }), kind: "chart" } satisfies WidgetData);
      }
      // One value for the window, or one per group.
      const grouped = display !== "number" && groupBy !== undefined;
      const rowLimit = grouped ? Math.min(limit ?? 10, 50) : 1;
      const aggregate = async (window: Required<TimeRange>) => {
        const filter = { range: window, resourceAttrs };
        if (type === "timeseries_metric") {
          return dependencies.metricWindowAggregate(granted.client, projectId, {
            ...(metricAggregation ? { aggregation: metricAggregation } : {}),
            filter,
            groupBy: grouped ? groupBy : undefined,
            ...(config.metricKind ? { kind: config.metricKind } : {}),
            limit: rowLimit,
            metricName: config.metricName!,
            ...(config.metricUnit !== undefined ? { unit: config.metricUnit } : {}),
          });
        }
        const by = grouped ? groupBy : undefined;
        return measure.aggregation === "count"
          ? dependencies.countAggregate(granted.client, projectId, source, filter, by, rowLimit)
          : dependencies.eventAggregate(granted.client, projectId, source, filter, measure, by, rowLimit, aiPrices);
      };
      const [current, previous] = await Promise.all([
        aggregate(range),
        comparing ? aggregate(previousWindow(range)) : Promise.resolve(null),
      ]);
      // Counted and summed logs and spans are zero when nothing matched; other
      // values have no value then.
      const empty = type === "timeseries_count" && additive ? 0 : null;
      if (!grouped) {
        const value = current[0]?.value ?? empty;
        return context.json({
          kind: "number",
          value,
          ...(previous ? { previous: previous[0]?.value ?? empty } : {}),
        } satisfies WidgetData);
      }
      const before = new Map(previous?.map((row) => [row.group, row.value]));
      return context.json({
        kind: "rows",
        rows: current.map((row) => ({
          group: row.group,
          value: row.value,
          ...(previous ? { previous: before.get(row.group) ?? empty } : {}),
        })),
      } satisfies WidgetData);
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
