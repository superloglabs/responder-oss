import { Hono } from "hono";
import {
  otlpSignalEndpoint,
  otlpSignalHeaders,
} from "../../../../packages/core/src/observability/opentelemetry.js";
import { getAuth } from "../auth.js";

// Browser traces of the application itself, at
// /api/telemetry/browser/v1/traces. Signed-in pages send OTLP JSON here, and
// the server forwards it to its own OTLP traces endpoint with its own headers,
// so the browser never holds an ingest key. Without a configured endpoint the
// route answers 404 and the browser stops sending.
export type BrowserRelayDependencies = {
  endpoint: () => string | null;
  forward: typeof fetch;
  headers: () => Record<string, string>;
  signedIn: (headers: Headers) => Promise<boolean>;
};

const defaultDependencies: BrowserRelayDependencies = {
  endpoint: () => otlpSignalEndpoint("traces"),
  forward: fetch,
  headers: () => otlpSignalHeaders("traces"),
  signedIn: async (headers) =>
    Boolean(await getAuth().api.getSession({ headers }).catch(() => null)),
};

const contentTypes = new Set(["application/json", "application/x-protobuf"]);

export function createBrowserRelayRoutes(
  dependencies: BrowserRelayDependencies = defaultDependencies,
) {
  return new Hono().post("/v1/traces", async (context) => {
    const endpoint = dependencies.endpoint();
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
        headers: { ...dependencies.headers(), "content-type": contentType },
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
