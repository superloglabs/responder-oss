import { beforeEach, describe, expect, it, vi } from "vitest";
import { telemetryToolSpecs } from "./telemetry-tools.js";
import { callWorkspaceTool } from "./workspace-tools.js";

const mocks = vi.hoisted(() => ({
  getTraceDetail: vi.fn(),
  listServices: vi.fn(),
  queryLogs: vi.fn(),
  queryMetrics: vi.fn(),
  queryTraces: vi.fn(),
}));

vi.mock("@responder/core/telemetry/query", async (importOriginal) => ({
  ...(await importOriginal()),
  ...mocks,
}));

const organizationId = "15151515-1515-4515-8515-151515151515";
const client = { query: vi.fn() };
const now = new Date("2026-11-04T10:00:00.000Z");

function tools() {
  const specs = telemetryToolSpecs({ organizationId }, { client: () => client as never, now: () => now });
  return Object.fromEntries(specs.map((spec) => [spec.name, spec]));
}

async function call(name: string, args: Record<string, unknown>) {
  const result = await callWorkspaceTool(tools()[name]!, args);
  return { body: result.content[0]!.text, isError: result.isError };
}

describe("telemetryToolSpecs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers no tools when the cell has no telemetry store", () => {
    expect(telemetryToolSpecs({ organizationId }, { client: () => null, now: () => now })).toEqual([]);
  });

  it("offers read-only tools named as on the MCP server", () => {
    expect(Object.values(tools()).map((tool) => [tool.name, tool.readOnly])).toEqual([
      ["list_services", true],
      ["query_logs", true],
      ["query_traces", true],
      ["get_trace", true],
      ["query_metrics", true],
    ]);
  });

  it("reads the last hour of the workspace's spans when the harness leaves out optional fields", async () => {
    mocks.queryTraces.mockResolvedValue([{
      duration_ms: "12.5",
      exception_message: "pool exhausted",
      exception_type: "TimeoutError",
      resource_attrs: { "deployment.environment": "production", "superlog.project_id": organizationId },
      service: "websites-api",
      span_attrs: { "http.route": "/cart" },
      span_id: "b7ad6b7169203331",
      span_name: "POST /cart",
      status_code: "STATUS_CODE_ERROR",
      timestamp: "2026-11-04 06:24:00.123456789",
      trace_id: "0af7651916cd43dd8448eb211c80319c",
    }]);

    const { body, isError } = await call("query_traces", {
      resourceAttributes: [{ key: "deployment.environment", value: "production" }],
      service: "websites-api",
      statusCode: "STATUS_CODE_ERROR",
    });

    expect(isError).toBeUndefined();
    expect(mocks.queryTraces).toHaveBeenCalledWith(client, organizationId, {
      limit: 50,
      range: { since: "2026-11-04T09:00:00.000Z", until: "2026-11-04T10:00:00.000Z" },
      resourceAttrs: [{ key: "deployment.environment", value: "production" }],
      service: "websites-api",
      statusCode: "STATUS_CODE_ERROR",
    });
    expect(JSON.parse(body)).toMatchObject({
      since: "2026-11-04T09:00:00.000Z",
      spans: [{
        durationMs: 12.5,
        exception: { message: "pool exhausted", stacktrace: "", type: "TimeoutError" },
        resourceAttributes: { "deployment.environment": "production" },
        statusCode: "STATUS_CODE_ERROR",
        timestamp: "2026-11-04T06:24:00.123456789Z",
      }],
    });
  });

  it("reads logs in an explicit window", async () => {
    mocks.queryLogs.mockResolvedValue([]);

    await call("query_logs", {
      limit: 10,
      search: "database connection",
      since: "2026-11-04T06:00:00Z",
      traceId: "0AF7651916CD43DD8448EB211C80319C",
      until: "2026-11-04T07:00:00Z",
    });

    expect(mocks.queryLogs).toHaveBeenCalledWith(client, organizationId, {
      limit: 10,
      range: { since: "2026-11-04T06:00:00.000Z", until: "2026-11-04T07:00:00.000Z" },
      search: "database connection",
      traceId: "0af7651916cd43dd8448eb211c80319c",
    });
  });

  it("tells the agent how to narrow a query that timed out", async () => {
    mocks.listServices.mockRejectedValue(Object.assign(new Error("Timeout error."), { name: "Error" }));

    expect(await call("list_services", { range: "7d" })).toEqual({
      body: "The query did not finish in time. Retry with a shorter window, more filters, or a lower limit.",
      isError: true,
    });
  });

  it("reports a trace that does not exist", async () => {
    mocks.getTraceDetail.mockResolvedValue({ logs: [], spans: [] });

    expect(await call("get_trace", { traceId: "0af7651916cd43dd8448eb211c80319c" })).toEqual({
      body: "Trace not found",
      isError: true,
    });
  });

  it("rejects a window over 30 days", async () => {
    expect(await call("query_metrics", { since: "2026-09-01T00:00:00Z" })).toEqual({
      body: "The window can be at most 30 days.",
      isError: true,
    });
    expect(mocks.queryMetrics).not.toHaveBeenCalled();
  });
});
