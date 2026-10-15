import {
  isSpanContextValid,
  trace,
  TraceFlags,
  type Context,
  type TextMapPropagator,
  type TextMapSetter,
} from "@opentelemetry/api";
import { CompositePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { DocumentLoadInstrumentation } from "@opentelemetry/instrumentation-document-load";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

// The server relays browser traces to its OTLP endpoint for signed-in users.
export const browserTraceRelayPath = "/api/telemetry/browser/v1/traces";

export interface BrowserTelemetryConfig {
  environment?: string;
  origin: string;
  release?: string;
  sampleRate: number;
}

// The API's Sentry propagator continues traces from the sentry-trace header,
// so requests to the API carry it next to traceparent.
export class SentryTraceHeaderPropagator implements TextMapPropagator {
  inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
    const spanContext = trace.getSpanContext(context);
    if (!spanContext || !isSpanContextValid(spanContext)) return;
    const sampled = (spanContext.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED;
    setter.set(carrier, "sentry-trace", `${spanContext.traceId}-${spanContext.spanId}-${sampled ? "1" : "0"}`);
  }

  extract(context: Context): Context {
    return context;
  }

  fields(): string[] {
    return ["sentry-trace"];
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// Only the application's own requests are traced; third-party requests,
// such as analytics, and the relay itself are not.
export function ignoredFetchUrls(origin: string): RegExp[] {
  return [
    new RegExp(`^(?!${escapeRegExp(origin)}/)`, "u"),
    new RegExp(`^${escapeRegExp(origin + browserTraceRelayPath)}`, "u"),
  ];
}

let started = false;

// Traces page loads and the application's API requests.
export function startBrowserTelemetry(config: BrowserTelemetryConfig): boolean {
  if (started || !(config.sampleRate > 0)) return false;
  started = true;

  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "responder-web",
      ...(config.environment ? { "deployment.environment.name": config.environment } : {}),
      ...(config.release ? { [ATTR_SERVICE_VERSION]: config.release } : {}),
    }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.sampleRate) }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: browserTraceRelayPath })),
    ],
  });
  provider.register({
    propagator: new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new SentryTraceHeaderPropagator()],
    }),
  });
  registerInstrumentations({
    instrumentations: [
      new DocumentLoadInstrumentation(),
      new FetchInstrumentation({
        clearTimingResources: true,
        ignoreUrls: ignoredFetchUrls(config.origin),
      }),
    ],
    tracerProvider: provider,
  });
  return true;
}
