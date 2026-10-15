import { Hono } from "hono";
import {
  findTelemetryIngestKey,
  hashTelemetryIngestToken,
  recordTelemetryIngestKeyUse,
} from "../../../../packages/core/src/db/telemetry-ingest-keys.js";
import { telemetryCollectorUrl } from "../../../../packages/core/src/telemetry/client.js";

// OTLP over HTTP from applications, at /api/ingest/v1/{logs,traces,metrics}.
// The key decides the workspace. Its organization ID is stamped as the
// collector request's x-superlog-project-id header, and the collector writes
// it onto every resource as superlog.project_id, replacing any superlog.*
// attribute the application sent.
export type IngestRouteDependencies = {
  collectorUrl: () => string | null;
  findKey: typeof findTelemetryIngestKey;
  forward: typeof fetch;
  now: () => number;
  recordUse: (keyId: string) => Promise<void>;
};

const defaultDependencies: IngestRouteDependencies = {
  collectorUrl: telemetryCollectorUrl,
  findKey: findTelemetryIngestKey,
  forward: fetch,
  now: Date.now,
  recordUse: (keyId) => recordTelemetryIngestKeyUse(keyId),
};

const signals = new Set(["logs", "metrics", "traces"]);
// How long a key lookup is reused. A revoked key stops working within it.
const keyCacheMs = 60_000;
const keyCacheLimit = 10_000;

function bearerToken(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  return headers.get("x-api-key")?.trim() || null;
}

export function createIngestRoutes(dependencies: IngestRouteDependencies = defaultDependencies) {
  const keys = new Map<string, { expires: number; keyId: string | null; organizationId: string | null }>();

  async function workspaceFor(token: string): Promise<{ keyId: string; organizationId: string } | null> {
    const hash = hashTelemetryIngestToken(token);
    const cached = keys.get(hash);
    if (cached && cached.expires > dependencies.now()) {
      return cached.organizationId && cached.keyId ? { keyId: cached.keyId, organizationId: cached.organizationId } : null;
    }
    const found = await dependencies.findKey(token);
    if (keys.size >= keyCacheLimit) keys.clear();
    keys.set(hash, {
      expires: dependencies.now() + keyCacheMs,
      keyId: found?.keyId ?? null,
      organizationId: found?.organizationId ?? null,
    });
    return found ? { keyId: found.keyId, organizationId: found.organizationId } : null;
  }

  return new Hono().post("/v1/:signal", async (context) => {
    const signal = context.req.param("signal");
    const collector = dependencies.collectorUrl();
    if (!collector || !signals.has(signal)) return context.json({ error: "Not found" }, 404);
    const token = bearerToken(context.req.raw.headers);
    const key = token ? await workspaceFor(token) : null;
    if (!key) return context.json({ error: "Send a valid ingest key as Authorization: Bearer <key>" }, 401);

    const headers = new Headers({
      "content-type": context.req.header("content-type") ?? "application/x-protobuf",
      "x-superlog-project-id": key.organizationId,
    });
    const encoding = context.req.header("content-encoding");
    if (encoding) headers.set("content-encoding", encoding);
    let response: Response;
    try {
      response = await dependencies.forward(`${collector}/v1/${signal}`, {
        body: await context.req.arrayBuffer(),
        headers,
        method: "POST",
      });
    } catch (error) {
      console.warn(JSON.stringify({ error: error instanceof Error ? error.message : String(error), event: "telemetry_ingest_forward_failed" }));
      return context.json({ error: "Telemetry ingest is unavailable" }, 503);
    }
    void dependencies.recordUse(key.keyId).catch(() => undefined);
    // The collector's answer, such as a partial success or a retry hint.
    const answer = new Headers({ "content-type": response.headers.get("content-type") ?? "application/json" });
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) answer.set("retry-after", retryAfter);
    return new Response(response.body, { headers: answer, status: response.status });
  });
}
