import { ROOT_CONTEXT, trace, TraceFlags } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({ init: vi.fn().mockReturnValue({}) }));
vi.mock("@superlog/browser", () => sdkMocks);

import { ignoredUrls, SentryTraceHeaderPropagator, startBrowserTelemetry } from "./browser-telemetry";

const setter = { set: (carrier: Record<string, string>, key: string, value: string) => { carrier[key] = value; } };

describe("browser telemetry", () => {
  it("adds a sentry-trace header so the API continues the browser's trace", () => {
    const propagator = new SentryTraceHeaderPropagator();
    const carrier: Record<string, string> = {};
    const context = trace.setSpanContext(ROOT_CONTEXT, {
      spanId: "b7ad6b7169203331",
      traceFlags: TraceFlags.SAMPLED,
      traceId: "0af7651916cd43dd8448eb211c80319c",
    });

    propagator.inject(context, carrier, setter);
    propagator.inject(ROOT_CONTEXT, carrier, setter);

    expect(carrier).toEqual({ "sentry-trace": "0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-1" });
    expect(propagator.fields()).toEqual(["sentry-trace"]);
  });

  it("traces only the application's own requests", () => {
    const ignored = ignoredUrls("https://superlog.sh");
    const isIgnored = (url: string) => ignored.some((pattern) => pattern.test(url));

    expect(isIgnored("https://superlog.sh/api/issues")).toBe(false);
    expect(isIgnored("https://eu.i.posthog.com/e/")).toBe(true);
    expect(isIgnored("https://superlog.sh.example.com/api")).toBe(true);
  });

  it("starts error and page-load capture with traces off at a zero sample rate", () => {
    const started = startBrowserTelemetry({
      endpoint: "https://superlog.sh/api/ingest",
      environment: "production",
      ingestKey: "sl_ingest_key",
      origin: "https://superlog.sh",
      release: "web-1",
      sampleRate: 0,
    });

    expect(started).toBe(true);
    expect(sdkMocks.init).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: "https://superlog.sh/api/ingest",
      ingestKey: "sl_ingest_key",
      service: "responder-web",
      tracesSampleRate: 0,
    }));
  });
});
