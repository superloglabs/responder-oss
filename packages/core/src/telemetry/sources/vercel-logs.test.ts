import { describe, expect, it } from "vitest";
import { parseVercelLogs, vercelLogsToOtlp } from "./vercel-logs.js";

const record = {
  deploymentId: "dpl_1",
  environment: "production",
  host: "shop.vercel.app",
  id: "log_1",
  level: "error",
  message: "Payment failed",
  projectId: "prj_1",
  projectName: "shop",
  proxy: { clientIp: "203.0.113.4", method: "POST", path: "/api/pay", statusCode: 500, userAgent: ["curl/8"] },
  source: "lambda",
  spanId: "00F067AA0BA902B7",
  timestamp: 1_760_000_000_123,
  traceId: "4BF92F3577B34DA6A3CE929D0E0E4736",
};

describe("parseVercelLogs", () => {
  it("reads an array, one record, or NDJSON", () => {
    expect(parseVercelLogs(JSON.stringify([record, record]), "application/json")).toHaveLength(2);
    expect(parseVercelLogs(JSON.stringify(record), "application/json")).toHaveLength(1);
    expect(parseVercelLogs(`${JSON.stringify(record)}\n\n${JSON.stringify(record)}\n`, "application/x-ndjson")).toHaveLength(2);
    expect(parseVercelLogs("  ", "application/json")).toEqual([]);
  });

  it("rejects records that are not objects", () => {
    expect(() => parseVercelLogs("[1]", "application/json")).toThrow("Invalid Vercel log record");
  });
});

describe("vercelLogsToOtlp", () => {
  it("maps a record to an OTLP log with its project as the service", () => {
    const payload = vercelLogsToOtlp([record]);
    const resource = payload.resourceLogs[0]!;
    const log = resource.scopeLogs[0]!.logRecords[0]!;

    expect(resource.resource.attributes).toEqual(expect.arrayContaining([
      { key: "service.name", value: { stringValue: "shop" } },
      { key: "telemetry.source", value: { stringValue: "vercel" } },
      { key: "deployment.environment.name", value: { stringValue: "production" } },
    ]));
    expect(log).toMatchObject({
      body: { stringValue: "Payment failed" },
      severityNumber: 17,
      severityText: "ERROR",
      spanId: "00f067aa0ba902b7",
      timeUnixNano: "1760000000123000000",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    });
    expect(log.attributes).toEqual(expect.arrayContaining([
      { key: "http.request.method", value: { stringValue: "POST" } },
      { key: "vercel.proxy.status_code", value: { intValue: "500" } },
      { key: "user_agent.original", value: { stringValue: "curl/8" } },
    ]));
  });

  it("groups records from the same project and host", () => {
    const other = { ...record, host: "admin.vercel.app", projectName: "admin" };
    const payload = vercelLogsToOtlp([record, other, record]);

    expect(payload.resourceLogs).toHaveLength(2);
    expect(payload.resourceLogs[0]!.scopeLogs[0]!.logRecords).toHaveLength(2);
  });
});
