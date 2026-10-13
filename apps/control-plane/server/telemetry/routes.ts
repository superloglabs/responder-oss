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
  getTraceDetail,
  listServices,
  queryLogs,
  queryTracesAggregated,
  type TimeRange,
} from "../../../../packages/core/src/telemetry/query.js";
import { getActiveTenant } from "../tenant.js";

// Read-only access to a workspace's OpenTelemetry data. A workspace sees
// telemetry only with the telemetry capability and a configured store, and
// only for the projects linked to it.
export type TelemetryRouteDependencies = {
  client: () => ClickHouseClient | null;
  findProject: (organizationId: string, projectId: string) => Promise<TelemetryProject | null>;
  hasTelemetry: (organizationId: string) => Promise<boolean>;
  listProjects: (organizationId: string) => Promise<TelemetryProject[]>;
  // Services that sent the signal in the window.
  listServices: (
    client: ClickHouseClient,
    projectId: string,
    range: TimeRange,
    signal: TelemetrySignal,
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
  client: getTelemetryClient,
  findProject: findTelemetryProject,
  hasTelemetry: (organizationId) => organizationHasCapability(organizationId, "telemetry"),
  listProjects: listTelemetryProjects,
  listServices,
  now: () => new Date(),
  queryLogs,
  queryTrace: async (client, projectId, traceId) => {
    const trace = await getTraceDetail(client, projectId, traceId);
    return { logs: trace.logs as unknown[], spans: trace.spans as unknown[] };
  },
  queryTraces: queryTracesAggregated,
  tenant: getActiveTenant,
};

const rangeMinutes = { "15m": 15, "1h": 60, "6h": 360, "24h": 1_440, "7d": 10_080 } as const;
export type TelemetryRange = keyof typeof rangeMinutes;

const windowSchema = z.object({
  projectId: z.uuid(),
  range: z.enum(Object.keys(rangeMinutes) as [TelemetryRange, ...TelemetryRange[]]).default("1h"),
});

const signals = ["logs", "traces"] as const;
export type TelemetrySignal = (typeof signals)[number];

const servicesSchema = windowSchema.extend({
  signal: z.enum(signals).default("logs"),
});

const tracesSchema = windowSchema.extend({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // Shortest total duration, in milliseconds, up to one hour.
  minDurationMs: z.coerce.number().min(0).max(3_600_000).optional(),
  service: z.string().trim().max(200).optional(),
  status: z.enum(["error"]).optional(),
});

const traceSchema = z.object({ projectId: z.uuid() });
const traceIdPattern = /^[0-9a-f]{32}$/u;

const logsSchema = windowSchema.extend({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  search: z.string().trim().max(200).optional(),
  service: z.string().trim().max(200).optional(),
  severity: z.string().trim().max(32).optional(),
});

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

  return new Hono()
    .get("/projects", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      return context.json({ projects: await dependencies.listProjects(granted.organizationId) });
    })
    .get("/logs", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const query = logsSchema.safeParse(context.req.query());
      if (!query.success) return context.json({ error: "Invalid log query" }, 400);
      if (!(await dependencies.findProject(granted.organizationId, query.data.projectId))) {
        return context.json({ error: "Telemetry project not found" }, 404);
      }
      const logs = await dependencies.queryLogs(granted.client, query.data.projectId, {
        limit: query.data.limit,
        range: windowFor(query.data.range, dependencies.now()),
        ...(query.data.search ? { search: query.data.search } : {}),
        ...(query.data.service ? { service: query.data.service } : {}),
        ...(query.data.severity ? { severity: query.data.severity } : {}),
      });
      return context.json({ logs });
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
          query.data.signal,
        ),
      });
    })
    .get("/traces", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const query = tracesSchema.safeParse(context.req.query());
      if (!query.success) return context.json({ error: "Invalid trace query" }, 400);
      if (!(await dependencies.findProject(granted.organizationId, query.data.projectId))) {
        return context.json({ error: "Telemetry project not found" }, 404);
      }
      const traces = await dependencies.queryTraces(granted.client, query.data.projectId, {
        limit: query.data.limit,
        range: windowFor(query.data.range, dependencies.now()),
        ...(query.data.minDurationMs ? { minDurationMs: query.data.minDurationMs } : {}),
        ...(query.data.service ? { service: query.data.service } : {}),
        ...(query.data.status === "error" ? { statusCode: "STATUS_CODE_ERROR" } : {}),
      });
      return context.json({ traces });
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
