import { describe, expect, it } from "vitest";
import { postHogId, postHogLogsToOtlp, type PostHogLogLine } from "./posthog-logs.js";

const now = new Date("2026-11-16T10:00:00Z");

function line(overrides: Partial<PostHogLogLine> = {}): PostHogLogLine {
  return {
    attributes: { "exception.type": "PaymentError", "http.status_code": "502" },
    body: "Payment for order 42 failed",
    instrumentation_scope: "payments",
    resource_attributes: { "deployment.environment": "production", "service.name": "api" },
    resource_fingerprint: "111",
    severity_number: 17,
    severity_text: "error",
    span_id: "ASNFZ4mrze8=",
    timestamp: "2026-11-16T09:59:01.123456Z",
    trace_id: "ASNFZ4mrze/+3LqYdlQyEA==",
    uuid: "0193-1",
    ...overrides,
  };
}

describe("postHogId", () => {
  it("reads base64 and hex IDs and drops unset ones", () => {
    expect(postHogId("ASNFZ4mrze/+3LqYdlQyEA==", 32)).toBe("0123456789abcdeffedcba9876543210");
    expect(postHogId("0123456789ABCDEFFEDCBA9876543210", 32)).toBe("0123456789abcdeffedcba9876543210");
    expect(postHogId("ASNFZ4mrze8=", 16)).toBe("0123456789abcdef");
    expect(postHogId("AAAAAAAAAAAAAAAAAAAAAA==", 32)).toBeUndefined();
    expect(postHogId("00000000000000000000000000000000", 32)).toBeUndefined();
    expect(postHogId("", 32)).toBeUndefined();
    expect(postHogId("ASNFZ4mrze8=", 32)).toBeUndefined();
  });
});

describe("postHogLogsToOtlp", () => {
  it("keeps each line's attributes and resource and restores OTLP IDs and severity", () => {
    const [request] = postHogLogsToOtlp([line()], { projectId: "12345", projectName: "Web app" }, { now });
    expect(request).toEqual({
      resourceLogs: [{
        resource: {
          attributes: [
            { key: "deployment.environment", value: { stringValue: "production" } },
            { key: "service.name", value: { stringValue: "api" } },
            { key: "cloud.provider", value: { stringValue: "posthog" } },
            { key: "posthog.project.id", value: { stringValue: "12345" } },
            { key: "posthog.project.name", value: { stringValue: "Web app" } },
          ],
        },
        scopeLogs: [{
          logRecords: [{
            attributes: [
              { key: "exception.type", value: { stringValue: "PaymentError" } },
              { key: "http.status_code", value: { stringValue: "502" } },
              { key: "posthog.log.uuid", value: { stringValue: "0193-1" } },
            ],
            body: { stringValue: "Payment for order 42 failed" },
            observedTimeUnixNano: "1794823200000000000",
            severityNumber: 17,
            severityText: "ERROR",
            spanId: "0123456789abcdef",
            timeUnixNano: "1794823141123456000",
            traceId: "0123456789abcdeffedcba9876543210",
          }],
          scope: { name: "payments" },
        }],
      }],
    });
  });

  it("names a service for lines without one and groups lines by resource", () => {
    const requests = postHogLogsToOtlp([
      line({ resource_attributes: {}, resource_fingerprint: "222", severity_number: 0, severity_text: "fatal", uuid: "a" }),
      line({ uuid: "b" }),
      line({ instrumentation_scope: null, uuid: "c" }),
    ], { projectId: "12345" }, { now });
    expect(requests).toHaveLength(1);
    const [unnamed, api] = requests[0]!.resourceLogs;
    expect(unnamed!.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "posthog" } });
    expect(unnamed!.scopeLogs[0]!.logRecords[0]).toEqual(expect.objectContaining({ severityNumber: 21, severityText: "FATAL" }));
    expect(api!.scopeLogs.map((scope) => [scope.scope.name, scope.logRecords.length])).toEqual([["payments", 1], ["posthog.logs", 1]]);
  });

  it("batches requests", () => {
    const lines = Array.from({ length: 5 }, (_, index) => line({ uuid: String(index) }));
    expect(postHogLogsToOtlp(lines, { projectId: "12345" }, { batch: 2, now })).toHaveLength(3);
  });
});
