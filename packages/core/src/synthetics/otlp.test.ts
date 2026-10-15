import { describe, expect, it } from "vitest";
import { syntheticRunMetrics } from "./otlp.js";

describe("syntheticRunMetrics", () => {
  it("writes uptime, duration and each phase as gauges with the run's attributes", () => {
    const payload = syntheticRunMetrics(
      { id: "check-1", method: "GET", name: "Shop", url: "https://shop.example.com/health?token=x" },
      {
        assertions: [],
        attempts: 1,
        durationMs: 120.5,
        error: null,
        response: { body: "", bodyBytes: 0, bodyTruncated: false, certificateExpiresAt: null, headers: {}, redirects: 0, statusCode: 503, url: "" },
        startedAt: "2026-10-15T12:00:00.000Z",
        status: "failed",
        timings: { connectMs: 10, dnsMs: 5, downloadMs: 5, firstByteMs: 90, tlsMs: 10 },
      },
      "eu-west-3",
    ) as { resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: Array<{ gauge: { dataPoints: Array<Record<string, unknown>> }; name: string }> }> }> };

    const metrics = payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
    expect(metrics.map((metric) => metric.name)).toEqual(["synthetic_check.up", "synthetic_check.duration", "synthetic_check.phase.duration"]);
    const [up] = metrics[0]!.gauge.dataPoints;
    expect(up).toMatchObject({ asDouble: 0, timeUnixNano: "1792065600000000000" });
    expect(up!.attributes).toEqual(
      expect.arrayContaining([
        { key: "synthetic_check.status", value: { stringValue: "failed" } },
        { key: "server.address", value: { stringValue: "shop.example.com" } },
        { key: "http.response.status_code", value: { intValue: "503" } },
      ]),
    );
    expect(JSON.stringify(payload)).not.toContain("token=x");
    expect(metrics[2]!.gauge.dataPoints).toHaveLength(5);
  });
});
