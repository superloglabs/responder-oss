import {
  isSpanContextValid,
  trace,
  TraceFlags,
  type Context,
  type TextMapPropagator,
  type TextMapSetter,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { init, type ErrorEvent } from "@superlog/browser";

export interface BrowserTelemetryConfig {
  endpoint: string;
  environment?: string;
  ingestKey: string;
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

// Errors from scripts the browser injects into the page, not from the
// application. Brave on iOS runs `window.ethereum.selectedAddress = undefined`
// on page load, which throws when its wallet is off.
export const ignoredErrors: RegExp[] = [/\bwindow\.ethereum\b/u];

const FRAME = /^\s+at\s|@.*:\d+:\d+$/u;
const ANONYMOUS_CODE_FRAME = /@<anonymous code>:\d+:\d+$/u;

// Firefox names a frame `<anonymous code>` when its code has no script URL.
// The application has no inline scripts and does not evaluate code, so such
// code comes from a browser extension, and an error raised only in it is the
// extension's.
export function dropAnonymousCodeErrors(event: ErrorEvent): ErrorEvent | null {
  const frames = (event.stacktrace ?? "").split("\n").map((line) => line.trimEnd()).filter((line) => FRAME.test(line));
  if (frames.length > 0 && frames.every((frame) => ANONYMOUS_CODE_FRAME.test(frame))) return null;
  return event;
}

// Sends the application's errors, page loads, Web Vitals, and API request
// traces to a Superlog ingest endpoint with @superlog/browser. The ingest key
// only adds telemetry to its workspace, so the page can hold it.
export function startBrowserTelemetry(config: BrowserTelemetryConfig): boolean {
  const client = init({
    beforeSend: dropAnonymousCodeErrors,
    endpoint: config.endpoint,
    environment: config.environment,
    ignoreErrors: ignoredErrors,
    ignoreUrls: ignoredUrls(config.origin),
    ingestKey: config.ingestKey,
    propagators: [new W3CTraceContextPropagator(), new SentryTraceHeaderPropagator()],
    release: config.release,
    service: "responder-web",
    tracesSampleRate: config.sampleRate,
  });
  return client !== null;
}
