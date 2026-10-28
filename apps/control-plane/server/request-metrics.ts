import { metrics, type Histogram } from "@opentelemetry/api";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";

let duration: Histogram | undefined;

function requestDuration(): Histogram {
  // Created on first use, after the meter provider has been registered.
  duration ??= metrics
    .getMeter("responder-control-plane")
    .createHistogram("http.server.request.duration", {
      advice: {
        explicitBucketBoundaries: [
          0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
        ],
      },
      description: "Duration of HTTP server requests.",
      unit: "s",
    });
  return duration;
}

// Records each API request's duration by method, route template, and status.
// Without a registered meter provider this records nothing.
export function requestMetrics(
  options: { histogram?: () => Histogram; now?: () => number } = {},
): MiddlewareHandler {
  const histogram = options.histogram ?? requestDuration;
  const now = options.now ?? (() => performance.now());
  return async function requestMetrics(context, next) {
    const started = now();
    let failed = false;
    try {
      await next();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      histogram().record((now() - started) / 1_000, {
        "http.request.method": context.req.method,
        "http.response.status_code": failed ? 500 : context.res.status,
        "http.route": routePath(context),
      });
    }
  };
}
