import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managementMcpRoutes } from "./mcp.js";
import { managementApiRoutes } from "./routes.js";
import { telemetryWindow } from "./telemetry-operations.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const userId = "21212121-2121-4121-8121-212121212121";
const apiKeyId = "31313131-3131-4131-8131-313131313131";
const traceId = "0af7651916cd43dd8448eb211c80319c";
const token = `slk_${"a".repeat(43)}`;

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  capability: vi.fn(),
  client: vi.fn(),
  getTraceDetail: vi.fn(),
  listServices: vi.fn(),
  queryLogs: vi.fn(),
  queryMetrics: vi.fn(),
  queryTraces: vi.fn(),
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
  organizationHasCapability: mocks.capability,
}));
vi.mock("../../../../packages/core/src/telemetry/client.js", () => ({
  getTelemetryClient: mocks.client,
}));
vi.mock("../../../../packages/core/src/telemetry/query.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getTraceDetail: mocks.getTraceDetail,
  listServices: mocks.listServices,
  queryLogs: mocks.queryLogs,
  queryMetrics: mocks.queryMetrics,
  queryTraces: mocks.queryTraces,
}));

const app = new Hono()
  .route("/api/v1", managementApiRoutes)
  .route("/api/mcp", managementMcpRoutes);
const clickhouse = { query: vi.fn() };

function api(path: string, body?: unknown) {
  return app.request(`/api/v1${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body), method: "POST" }),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
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

const logRow = {
  body: "payment failed",
  event_name: "payment.failed",
  exception_message: "card declined",
  exception_stacktrace: "Error: card declined\n    at charge (pay.ts:12)",
  exception_type: "CardError",
  log_attrs: { "event.name": "payment.failed" },
  resource_attrs: { "deployment.environment": "prod", "service.name": "api", "superlog.project_id": organizationId },
  service: "api",
  severity: "ERROR",
  severity_number: 17,
  span_id: "b7ad6b7169203331",
  timestamp: "2026-10-16 09:59:58.123456789",
  trace_id: traceId,
};

const spanRow = {
  duration_ms: 812.5,
  exception_message: "",
  exception_stacktrace: "",
  exception_type: "",
  parent_span_id: "",
  resource_attrs: { "service.name": "api" },
  service: "api",
  span_attrs: { "http.response.status_code": "500", "http.route": "/charge" },
  span_id: "b7ad6b7169203331",
  span_kind: "SPAN_KIND_SERVER",
  span_name: "POST /charge",
  status_code: "STATUS_CODE_ERROR",
  status_message: "",
  timestamp: "2026-10-16 09:59:57.900000000",
  trace_id: traceId,
};

describe("telemetry operations", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-16T10:00:00.000Z"), toFake: ["Date"] });
    mocks.authenticate.mockResolvedValue({
      apiKeyId,
      organizationId,
      role: "member",
      user: { email: "ash@example.com", id: userId, name: "Ash" },
    });
    mocks.capability.mockImplementation(async (_organization: string, capability: string) => capability === "telemetry");
    mocks.client.mockReturnValue(clickhouse);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("lists the telemetry tools as read-only", async () => {
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

    for (const name of ["query_logs", "query_traces", "get_trace", "query_metrics", "list_services"]) {
      expect(result.tools.find((tool) => tool.name === name)?.annotations, name)
        .toMatchObject({ destructiveHint: false, openWorldHint: false, readOnlyHint: true });
    }
  });

  it("searches the workspace's logs and returns readable rows", async () => {
    mocks.queryLogs.mockResolvedValue([logRow]);

    const result = await callTool("query_logs", {
      attributes: [{ key: "event.name", value: "payment.failed" }],
      range: "6h",
      resourceAttributes: [{ key: "deployment.environment", op: "neq", value: "staging" }],
      search: "payment",
      service: "api",
      severity: "ERROR",
      traceId: traceId.toUpperCase(),
    });

    expect(result.isError).toBeUndefined();
    expect(mocks.queryLogs).toHaveBeenCalledWith(clickhouse, organizationId, {
      limit: 50,
      logAttrs: [{ key: "event.name", value: "payment.failed" }],
      range: { since: "2026-10-16T04:00:00.000Z", until: "2026-10-16T10:00:00.000Z" },
      resourceAttrs: [{ key: "deployment.environment", op: "neq", value: "staging" }],
      search: "payment",
      service: "api",
      severity: "ERROR",
      traceId,
    });
    expect(result.body).toEqual({
      logs: [{
        attributes: { "event.name": "payment.failed" },
        body: "payment failed",
        eventName: "payment.failed",
        exception: {
          message: "card declined",
          stacktrace: "Error: card declined\n    at charge (pay.ts:12)",
          type: "CardError",
        },
        resourceAttributes: { "deployment.environment": "prod", "service.name": "api" },
        service: "api",
        severity: "ERROR",
        severityNumber: 17,
        spanId: "b7ad6b7169203331",
        timestamp: "2026-10-16T09:59:58.123456789Z",
        traceId,
      }],
      since: "2026-10-16T04:00:00.000Z",
      until: "2026-10-16T10:00:00.000Z",
    });
  });

  it("searches spans by HTTP attributes and span status", async () => {
    mocks.queryTraces.mockResolvedValue([spanRow]);

    const result = await callTool("query_traces", {
      attributes: [{ key: "http.response.status_code", value: "500" }],
      minDurationMs: 500,
      name: "POST /charge",
      since: "2026-10-16T09:00:00Z",
      statusCode: "STATUS_CODE_ERROR",
    });

    expect(mocks.queryTraces).toHaveBeenCalledWith(clickhouse, organizationId, {
      limit: 50,
      minDurationMs: 500,
      range: { since: "2026-10-16T09:00:00.000Z", until: "2026-10-16T10:00:00.000Z" },
      spanAttrs: [{ key: "http.response.status_code", value: "500" }],
      spanName: "POST /charge",
      statusCode: "STATUS_CODE_ERROR",
    });
    expect(result.body.spans).toEqual([expect.objectContaining({
      attributes: { "http.response.status_code": "500", "http.route": "/charge" },
      durationMs: 812.5,
      exception: null,
      kind: "SPAN_KIND_SERVER",
      name: "POST /charge",
      statusCode: "STATUS_CODE_ERROR",
    })]);
  });

  it("returns a trace's spans and logs", async () => {
    mocks.getTraceDetail.mockResolvedValue({ logs: [logRow], spans: [spanRow] });

    const response = await api(`/telemetry/traces/${traceId.toUpperCase()}`);
    const body = await response.json() as { logs: unknown[]; spans: unknown[] };

    expect(response.status).toBe(200);
    expect(mocks.getTraceDetail).toHaveBeenCalledWith(clickhouse, organizationId, traceId);
    expect(body.spans).toHaveLength(1);
    expect(body.logs).toHaveLength(1);
  });

  it("answers an unknown trace with not found", async () => {
    mocks.getTraceDetail.mockResolvedValue({ logs: [], spans: [] });

    const result = await callTool("get_trace", { traceId });

    expect(result).toEqual({ body: { code: "trace_not_found", error: "Trace not found" }, isError: true });
  });

  it("turns ClickHouse integers into numbers on metric points", async () => {
    mocks.queryMetrics.mockResolvedValue([{
      aggregation_temporality: 2,
      attributes: { route: "/charge" },
      count: "42",
      is_monotonic: null,
      kind: "histogram",
      max: 900,
      metric_name: "http.server.duration",
      min: 3,
      resource_attrs: { "service.name": "api" },
      service: "api",
      start_time: "2026-10-16 09:59:00.000000000",
      sum: 5120.5,
      timestamp: "2026-10-16 09:59:30.000000000",
      unit: "ms",
      value: null,
    }]);

    const response = await api("/telemetry/metrics/search", { name: "http.server.duration" });
    const body = await response.json() as { points: unknown[] };

    expect(response.status).toBe(200);
    expect(mocks.queryMetrics).toHaveBeenCalledWith(clickhouse, organizationId, expect.objectContaining({
      limit: 100,
      metricName: "http.server.duration",
    }));
    expect(body.points).toEqual([{
      aggregationTemporality: 2,
      attributes: { route: "/charge" },
      count: 42,
      isMonotonic: null,
      kind: "histogram",
      max: 900,
      min: 3,
      name: "http.server.duration",
      resourceAttributes: { "service.name": "api" },
      service: "api",
      startTime: "2026-10-16T09:59:00.000000000Z",
      sum: 5120.5,
      timestamp: "2026-10-16T09:59:30.000000000Z",
      unit: "ms",
      value: null,
    }]);
  });

  it("lists services that sent telemetry", async () => {
    mocks.listServices.mockResolvedValue(["api", "worker"]);

    const response = await api("/telemetry/services?range=24h");

    expect(await response.json()).toEqual({
      services: ["api", "worker"],
      since: "2026-10-15T10:00:00.000Z",
      until: "2026-10-16T10:00:00.000Z",
    });
  });

  it("is unavailable without the telemetry feature or a telemetry store", async () => {
    mocks.capability.mockResolvedValue(false);
    expect(await callTool("list_services")).toEqual({
      body: { code: "telemetry_unavailable", error: "Telemetry is not available in this workspace." },
      isError: true,
    });

    mocks.capability.mockResolvedValue(true);
    mocks.client.mockReturnValue(null);
    expect((await callTool("query_logs")).body.code).toBe("telemetry_unavailable");
    expect(mocks.listServices).not.toHaveBeenCalled();
    expect(mocks.queryLogs).not.toHaveBeenCalled();
  });

  it("asks for a narrower query when ClickHouse times out", async () => {
    mocks.queryLogs.mockRejectedValue(Object.assign(new Error("Timeout error."), { name: "Error" }));

    const result = await callTool("query_logs", { range: "7d" });

    expect(result).toEqual({
      body: {
        code: "telemetry_query_timeout",
        error: "The query did not finish in time. Retry with a shorter window, more filters, or a lower limit.",
      },
      isError: true,
    });
  });
});

describe("telemetryWindow", () => {
  const now = new Date("2026-10-16T10:00:00.000Z");

  it("reads back from now, or from an explicit start", () => {
    expect(telemetryWindow({ range: "1h" }, now)).toEqual({
      since: "2026-10-16T09:00:00.000Z",
      until: "2026-10-16T10:00:00.000Z",
    });
    expect(telemetryWindow({ range: "1h", since: "2026-10-01T00:00:00+02:00" }, now)).toEqual({
      since: "2026-09-30T22:00:00.000Z",
      until: "2026-10-16T10:00:00.000Z",
    });
    expect(telemetryWindow({ range: "15m", until: "2026-10-15T12:00:00Z" }, now)).toEqual({
      since: "2026-10-15T11:45:00.000Z",
      until: "2026-10-15T12:00:00.000Z",
    });
  });

  it("rejects backwards windows and windows over 30 days", () => {
    expect(() => telemetryWindow({ range: "1h", since: "2026-10-16T11:00:00Z" }, now))
      .toThrow("`since` must be before `until`.");
    expect(() => telemetryWindow({ range: "1h", since: "2026-09-01T00:00:00Z" }, now))
      .toThrow("The window can be at most 30 days.");
  });
});
