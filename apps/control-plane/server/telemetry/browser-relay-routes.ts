import { Hono } from "hono";
import {
  otlpSignalEndpoint,
  otlpSignalHeaders,
} from "../../../../packages/core/src/observability/opentelemetry.js";
import { getAuth } from "../auth.js";

// Browser telemetry of the application itself, at
// /api/telemetry/browser/v1/traces and /v1/logs, where its errors arrive.
// Signed-in pages send OTLP here, and the server forwards it to its own OTLP
// endpoint for the signal with its own headers, so the browser never holds an
// ingest key. Without a configured endpoint the route answers 404 and the
// browser stops sending.
export type BrowserSignal = "logs" | "traces";

export type BrowserRelayDependencies = {
  endpoint: (signal: BrowserSignal) => string | null;
  forward: typeof fetch;
  headers: (signal: BrowserSignal) => Record<string, string>;
  signedIn: (headers: Headers) => Promise<boolean>;
};

const defaultDependencies: BrowserRelayDependencies = {
  endpoint: (signal) => otlpSignalEndpoint(signal),
  forward: fetch,
  headers: (signal) => otlpSignalHeaders(signal),
  signedIn: async (headers) =>
    Boolean(await getAuth().api.getSession({ headers }).catch(() => null)),
};

const contentTypes = new Set(["application/json", "application/x-protobuf"]);

export function createBrowserRelayRoutes(
  dependencies: BrowserRelayDependencies = defaultDependencies,
) {
  return new Hono().post("/v1/:signal{traces|logs}", async (context) => {
    const signal = context.req.param("signal") as BrowserSignal;
    const endpoint = dependencies.endpoint(signal);
    if (!endpoint) return context.json({ error: "Not found" }, 404);
    if (!(await dependencies.signedIn(context.req.raw.headers))) {
      return context.json({ error: "Unauthorized" }, 401);
    }
    const contentType = context.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!contentTypes.has(contentType)) {
      return context.json({ error: "Send OTLP as application/json or application/x-protobuf" }, 415);
    }

    try {
      const response = await dependencies.forward(endpoint, {
        body: await context.req.arrayBuffer(),
        headers: { ...dependencies.headers(signal), "content-type": contentType },
        method: "POST",
      });
      return new Response(response.body, {
        headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
        status: response.status,
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          event: "browser_telemetry_forward_failed",
        }),
      );
      return context.json({ error: "Telemetry export is unavailable" }, 503);
    }
  });
}
