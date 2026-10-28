import { ROOT_CONTEXT, trace, TraceFlags } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { ignoredUrls, SentryTraceHeaderPropagator } from "./browser-telemetry";

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
});
