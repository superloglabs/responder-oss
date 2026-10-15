import { ROOT_CONTEXT, SpanKind, trace, TraceFlags } from "@opentelemetry/api";
import type { Logger, LogRecord } from "@opentelemetry/api-logs";
import { SamplingDecision, type Sampler } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import {
  consoleLogRecord,
  DetachedSpanSampler,
  forwardConsoleToLogger,
  nodeTelemetryResource,
  otlpExportConfigured,
  otlpSignalEndpoint,
  otlpSignalHeaders,
} from "./opentelemetry";

const alwaysSample: Sampler = {
  shouldSample: () => ({ decision: SamplingDecision.RECORD_AND_SAMPLED }),
  toString: () => "AlwaysSample",
};
const traceId = "0af7651916cd43dd8448eb211c80319c";
const parentContext = trace.setSpanContext(ROOT_CONTEXT, {
  spanId: "b7ad6b7169203331",
  traceFlags: TraceFlags.SAMPLED,
  traceId,
});

describe("OpenTelemetry configuration", () => {
  it("exports only when an OTLP endpoint is configured", () => {
    expect(otlpExportConfigured({})).toBe(false);
    expect(otlpExportConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: " " })).toBe(false);
    expect(
      otlpExportConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://superlog.sh/api/ingest" }),
    ).toBe(true);
    expect(
      otlpExportConfigured({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector:4318/v1/traces" }),
    ).toBe(true);
    expect(
      otlpExportConfigured({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://superlog.sh/api/ingest",
        OTEL_SDK_DISABLED: "TRUE",
      }),
    ).toBe(false);
  });

  it("resolves each signal's endpoint and headers", () => {
    const environment = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://superlog.sh/api/ingest/",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20sl_key,x-team=core",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://collector:4318/custom/logs",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-team=web",
    };
    expect(otlpSignalEndpoint("traces", environment)).toBe("https://superlog.sh/api/ingest/v1/traces");
    expect(otlpSignalEndpoint("logs", environment)).toBe("http://collector:4318/custom/logs");
    expect(otlpSignalEndpoint("traces", {})).toBeNull();
    expect(otlpSignalHeaders("traces", environment)).toEqual({
      Authorization: "Bearer sl_key",
      "x-team": "web",
    });
    expect(otlpSignalHeaders("metrics", environment)).toEqual({
      Authorization: "Bearer sl_key",
      "x-team": "core",
    });
  });

  it("describes the service from the environment", () => {
    const resource = nodeTelemetryResource("responder-worker", {
      AWS_REGION: "eu-west-3",
      OTEL_RESOURCE_ATTRIBUTES: "responder.cell=eu,deployment.environment.name=prod-eu",
      SENTRY_ENVIRONMENT: "production",
      SENTRY_RELEASE: "worker-abc123",
    });
    expect(resource.attributes).toMatchObject({
      "cloud.region": "eu-west-3",
      "deployment.environment.name": "prod-eu",
      "responder.cell": "eu",
      "service.name": "responder-worker",
      "service.version": "worker-abc123",
    });
    expect(
      nodeTelemetryResource("responder-worker", { OTEL_SERVICE_NAME: "custom" })
        .attributes["service.name"],
    ).toBe("custom");
  });
});

describe("DetachedSpanSampler", () => {
  const sampler = new DetachedSpanSampler(alwaysSample);

  it("drops database spans that start outside a request or job", () => {
    expect(
      sampler.shouldSample(ROOT_CONTEXT, traceId, "SELECT", SpanKind.CLIENT, { "db.system": "postgresql" }, [])
        .decision,
    ).toBe(SamplingDecision.NOT_RECORD);
    expect(
      sampler.shouldSample(ROOT_CONTEXT, traceId, "pg-pool.connect", SpanKind.CLIENT, {}, []).decision,
    ).toBe(SamplingDecision.NOT_RECORD);
  });

  it("drops middleware spans of requests that are not traced", () => {
    const remoteParent = trace.setSpanContext(ROOT_CONTEXT, {
      isRemote: true,
      spanId: "b7ad6b7169203331",
      traceFlags: TraceFlags.SAMPLED,
      traceId,
    });
    const middleware = { "sentry.op": "middleware.hono" };
    expect(
      sampler.shouldSample(remoteParent, traceId, "<anonymous>", SpanKind.INTERNAL, middleware, []).decision,
    ).toBe(SamplingDecision.NOT_RECORD);
    expect(
      sampler.shouldSample(remoteParent, traceId, "SELECT", SpanKind.CLIENT, { "db.system": "postgresql" }, [])
        .decision,
    ).toBe(SamplingDecision.NOT_RECORD);
    expect(
      sampler.shouldSample(parentContext, traceId, "<anonymous>", SpanKind.INTERNAL, middleware, []).decision,
    ).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it("keeps database spans inside a trace and other root spans", () => {
    expect(
      sampler.shouldSample(parentContext, traceId, "SELECT", SpanKind.CLIENT, { "db.system": "postgresql" }, [])
        .decision,
    ).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(
      sampler.shouldSample(ROOT_CONTEXT, traceId, "investigation", SpanKind.CONSUMER, {}, []).decision,
    ).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });
});

describe("console log records", () => {
  it("turns a JSON log line into an event with attributes", () => {
    expect(
      consoleLogRecord([
        JSON.stringify({ event: "control_plane_listening", nested: { a: 1 }, none: null, port: 3000 }),
      ]),
    ).toEqual({
      attributes: { event: "control_plane_listening", nested: '{"a":1}', port: 3000 },
      body: "control_plane_listening",
    });
  });

  it("formats other lines as written", () => {
    expect(consoleLogRecord(["listening on %d", 8787])).toEqual({
      attributes: {},
      body: "listening on 8787",
    });
    expect(consoleLogRecord(["{not json}"]).body).toBe("{not json}");
  });

  it("writes the line and emits a record with its severity", () => {
    const written: unknown[][] = [];
    const emitted: LogRecord[] = [];
    const target = {
      debug: (...args: unknown[]) => written.push(args),
      error: (...args: unknown[]) => written.push(args),
      info: (...args: unknown[]) => written.push(args),
      log: (...args: unknown[]) => written.push(args),
      warn: (...args: unknown[]) => written.push(args),
    } as unknown as Console;
    const logger = { emit: (record: LogRecord) => emitted.push(record) } as unknown as Logger;

    const restore = forwardConsoleToLogger(logger, target);
    target.warn(JSON.stringify({ event: "telemetry_ingest_forward_failed" }));
    target.error("plain", "line");
    restore();
    target.info("after restore");

    expect(written).toHaveLength(3);
    expect(emitted.map((record) => [record.severityText, record.body])).toEqual([
      ["WARN", "telemetry_ingest_forward_failed"],
      ["ERROR", "plain line"],
    ]);
  });
});
