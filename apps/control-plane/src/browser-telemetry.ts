import {
  isSpanContextValid,
  trace,
  TraceFlags,
  type Context,
  type TextMapPropagator,
  type TextMapSetter,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { init } from "@superlog/browser";

// The server relays browser telemetry to its OTLP endpoint for signed-in
// users, at /v1/traces and /v1/logs under this path.
export const browserTelemetryRelayPath = "/api/telemetry/browser";

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
// such as analytics, are not.
export function ignoredUrls(origin: string): RegExp[] {
  return [new RegExp(`^(?!${escapeRegExp(origin)}/)`, "u")];
}

// Sends the application's errors, page loads, Web Vitals, and API request
// traces through the relay with @superlog/browser.
export function startBrowserTelemetry(config: BrowserTelemetryConfig): boolean {
  if (!(config.sampleRate > 0)) return false;
  const client = init({
    endpoint: `${config.origin}${browserTelemetryRelayPath}`,
    environment: config.environment,
    ignoreUrls: ignoredUrls(config.origin),
    propagators: [new W3CTraceContextPropagator(), new SentryTraceHeaderPropagator()],
    release: config.release,
    service: "responder-web",
    tracesSampleRate: config.sampleRate,
  });
  return client !== null;
}
