import { describe, expect, it } from "vitest";
import { gcpLogEntriesToOtlp, gcpTimeSeriesToOtlp } from "./gcp-telemetry.js";

describe("gcpLogEntriesToOtlp", () => {
  it("maps entries to logs grouped by resource", () => {
    const resource = { labels: { project_id: "shop-prod", service_name: "checkout" }, type: "cloud_run_revision" };
    const payload = gcpLogEntriesToOtlp(
      [
        {
          httpRequest: { requestMethod: "GET", status: 502 },
          insertId: "a",
          logName: "projects/shop-prod/logs/run.googleapis.com%2Frequests",
          receiveTimestamp: "2026-10-15T10:00:01.5Z",
          resource,
          severity: "ERROR",
          spanId: "00f067aa0ba902b7",
          textPayload: "upstream failed",
          timestamp: "2026-10-15T10:00:00.123456789Z",
          trace: "projects/shop-prod/traces/4bf92f3577b34da6a3ce929d0e0e4736",
          traceSampled: true,
        },
        { jsonPayload: { message: "ready" }, resource, severity: "DEFAULT", timestamp: "2026-10-15T10:00:02Z" },
      ],
      "shop-prod",
    );

    expect(payload.resourceLogs).toHaveLength(1);
    expect(payload.resourceLogs[0]!.resource.attributes).toEqual(expect.arrayContaining([
      { key: "service.name", value: { stringValue: "checkout" } },
      { key: "gcp.project.id", value: { stringValue: "shop-prod" } },
      { key: "gcp.resource.type", value: { stringValue: "cloud_run_revision" } },
    ]));
    const [first, second] = payload.resourceLogs[0]!.scopeLogs[0]!.logRecords;
    expect(first).toMatchObject({
      body: { stringValue: "upstream failed" },
      flags: 1,
      severityNumber: 17,
      spanId: "00f067aa0ba902b7",
      timeUnixNano: "1792058400123456789",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    });
    expect(first!.attributes).toContainEqual({ key: "http.response.status_code", value: { intValue: "502" } });
    expect(second).toMatchObject({ body: { stringValue: "ready" }, severityNumber: 0, severityText: "" });
  });
});

describe("gcpTimeSeriesToOtlp", () => {
  it("maps gauges, sums and distributions", () => {
    const resource = { labels: { service_name: "checkout" }, type: "cloud_run_revision" };
    const interval = { endTime: "2026-10-15T10:00:00Z", startTime: "2026-10-15T09:59:00Z" };
    const payload = gcpTimeSeriesToOtlp(
      [
        { metric: { type: "run.googleapis.com/container/cpu/utilizations" }, metricKind: "GAUGE", points: [{ interval, value: { doubleValue: 0.5 } }], resource, valueType: "DOUBLE" },
        { metric: { labels: { response_code: "200" }, type: "run.googleapis.com/request_count" }, metricKind: "DELTA", points: [{ interval, value: { int64Value: "12" } }], resource, valueType: "INT64" },
        {
          metric: { type: "run.googleapis.com/request_latencies" },
          metricKind: "DELTA",
          points: [{
            interval,
            value: { distributionValue: { bucketCounts: ["0", "3", "1"], bucketOptions: { explicitBuckets: { bounds: [10, 100] } }, count: "4", mean: 25 } },
          }],
          resource,
          valueType: "DISTRIBUTION",
        },
      ],
      "shop-prod",
    );

    const [gauge, sum, histogram] = payload.resourceMetrics.map((item) => item.scopeMetrics[0]!.metrics[0]!);
    expect(gauge).toMatchObject({ gauge: { dataPoints: [{ asDouble: 0.5, timeUnixNano: "1792058400000000000" }] } });
    expect(sum).toMatchObject({
      sum: {
        aggregationTemporality: 1,
        dataPoints: [{ asInt: "12", attributes: [{ key: "gcp.metric.label.response_code", value: { stringValue: "200" } }] }],
        isMonotonic: false,
      },
    });
    expect(histogram).toMatchObject({
      histogram: { dataPoints: [{ bucketCounts: ["0", "3", "1"], count: "4", explicitBounds: [10, 100], sum: 100 }] },
    });
  });
});
