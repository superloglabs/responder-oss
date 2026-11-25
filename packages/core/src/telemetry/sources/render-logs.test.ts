import { describe, expect, it } from "vitest";
import type { RenderLogLine } from "../../integrations/render.js";
import { renderLabel, renderLogBlocks, renderLogsToOtlp, stripAnsi } from "./render-logs.js";

function line(
  timestamp: string,
  message: string,
  labels: Record<string, string> = {},
  id: string | null = `${timestamp}-${message}`,
): RenderLogLine {
  return {
    id,
    labels: Object.entries({ instance: "srv-web-abc12", level: "info", resource: "srv-web", type: "app", ...labels })
      .map(([name, value]) => ({ name, value })),
    message,
    timestamp,
  };
}

function attributesOf(record: { attributes: Array<{ key: string; value: Record<string, unknown> }> }) {
  return Object.fromEntries(record.attributes.map((item) => [item.key, Object.values(item.value)[0]]));
}

const context = {
  ownerId: "tea-example",
  services: { "srv-web": { name: "web", region: "oregon", type: "web_service" } },
  workspaceName: "Example Team",
};

describe("renderLogBlocks", () => {
  it("joins a stack trace into one error per instance", () => {
    const blocks = renderLogBlocks([
      line("2026-11-25T10:00:00.000001Z", "TypeError: Cannot read properties of undefined (reading 'id')", { level: "error" }),
      line("2026-11-25T10:00:00.000002Z", "    at handler (/app/src/orders.js:12:5)", { level: "error" }),
      line("2026-11-25T10:00:00.000003Z", "starting worker", { instance: "srv-web-def34" }),
      line("2026-11-25T10:00:00.000004Z", "    at process (/app/src/queue.js:4:1)", { level: "error" }),
    ]);

    expect(blocks.map((block) => block.lines)).toEqual([
      [
        "TypeError: Cannot read properties of undefined (reading 'id')",
        "    at handler (/app/src/orders.js:12:5)",
        "    at process (/app/src/queue.js:4:1)",
      ],
      ["starting worker"],
    ]);
    expect(blocks[0]!.severity.text).toBe("ERROR");
  });

  it("keeps request logs apart from application lines and leaves out build logs", () => {
    const blocks = renderLogBlocks([
      line("2026-11-25T10:00:00.000001Z", "GET /orders 500", { method: "GET", path: "/orders", statusCode: "500", type: "request" }),
      line("2026-11-25T10:00:00.000002Z", "    indented app line"),
      line("2026-11-25T10:00:00.000003Z", "==> Building...", { type: "build" }),
    ]);

    expect(blocks.map((block) => block.lines)).toEqual([["GET /orders 500"], ["    indented app line"]]);
  });

  it("keeps each request log on its own, even one without text", () => {
    const blocks = renderLogBlocks([
      line("2026-11-25T10:00:00.000001Z", "GET /orders 200", { method: "GET", path: "/orders", statusCode: "200", type: "request" }),
      line("2026-11-25T10:00:00.000002Z", "  ", { method: "POST", path: "/checkout", statusCode: "502", type: "request" }),
    ]);

    expect(blocks.map((block) => block.lines)).toEqual([["GET /orders 200"], ["POST /checkout 502"]]);
    expect(renderLabel(blocks[1]!.first, "statusCode")).toBe("502");
  });

  it("strips terminal colors and reads a lower level an error line names", () => {
    const [block] = renderLogBlocks([line("2026-11-25T10:00:00Z", "\u001b[32mINFO\u001b[0m: server ready", { level: "error" })]);

    expect(block!.lines).toEqual(["INFO: server ready"]);
    expect(block!.severity.text).toBe("INFO");
    expect(stripAnsi("\u001b[1;31mred\u001b[0m")).toBe("red");
  });
});

describe("renderLogsToOtlp", () => {
  it("names the service and keeps request fields under OpenTelemetry's names", () => {
    const blocks = renderLogBlocks([
      line("2026-11-25T10:00:00.5Z", "POST /checkout 502", {
        clientIP: "203.0.113.9",
        host: "web.example.com",
        method: "POST",
        path: "/checkout",
        requestID: "req-1",
        statusCode: "502",
        type: "request",
      }, "log-1"),
    ]);

    const [request] = renderLogsToOtlp(blocks, context, { now: new Date("2026-11-25T10:01:00Z") });
    const resource = request!.resourceLogs[0]!;
    const record = resource.scopeLogs[0]!.logRecords[0]!;

    expect(attributesOf(resource.resource)).toEqual({
      "cloud.provider": "render",
      "cloud.region": "oregon",
      "render.owner_id": "tea-example",
      "render.service_id": "srv-web",
      "render.service_type": "web_service",
      "render.workspace_name": "Example Team",
      "service.name": "web",
      "telemetry.source": "render",
    });
    expect(attributesOf(record)).toEqual({
      "http.request.method": "POST",
      "http.response.status_code": "502",
      "render.clientIP": "203.0.113.9",
      "render.instance_id": "srv-web-abc12",
      "render.log_id": "log-1",
      "render.log_type": "request",
      "render.request_id": "req-1",
      "server.address": "web.example.com",
      "url.path": "/checkout",
    });
    expect(record.timeUnixNano).toBe("1795600800500000000");
    expect(resource.scopeLogs[0]!.scope.name).toBe("render.logs");
  });

  it("marks a Node error with its exception and names an unknown service by its ID", () => {
    const blocks = renderLogBlocks([
      line("2026-11-25T10:00:00.000001Z", "Error: connect ECONNREFUSED 10.0.0.4:5432", { level: "error", resource: "srv-new" }),
      line("2026-11-25T10:00:00.000002Z", "    at TCPConnectWrap.afterConnect (node:net:1595:16)", { level: "error", resource: "srv-new" }),
    ]);

    const [request] = renderLogsToOtlp(blocks, context);
    const resource = request!.resourceLogs[0]!;

    expect(attributesOf(resource.resource)["service.name"]).toBe("srv-new");
    expect(attributesOf(resource.scopeLogs[0]!.logRecords[0]!)).toMatchObject({
      "exception.message": "connect ECONNREFUSED 10.0.0.4:5432",
      "exception.type": "Error",
    });
  });

  it("sends at most one batch of logs a request", () => {
    const blocks = renderLogBlocks(Array.from({ length: 5 }, (_, index) => line(`2026-11-25T10:00:0${index}Z`, `line ${index}`)));

    expect(renderLogsToOtlp(blocks, context, { batch: 2 })).toHaveLength(3);
  });
});
