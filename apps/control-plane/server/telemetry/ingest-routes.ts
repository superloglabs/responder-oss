import { gunzipSync } from "node:zlib";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  findTelemetryIngestKey,
  hashTelemetryIngestToken,
  recordTelemetryIngestKeyUse,
} from "../../../../packages/core/src/db/telemetry-ingest-keys.js";
import { telemetryCollectorUrl } from "../../../../packages/core/src/telemetry/client.js";
import {
  cloudWatchLogsToOtlp,
  firehoseAnswer,
  firehoseRequestSchema,
  firehoseSource,
  metricStreamRequest,
} from "../../../../packages/core/src/telemetry/sources/aws-firehose.js";
import { parseVercelLogs, vercelLogsToOtlp } from "../../../../packages/core/src/telemetry/sources/vercel-logs.js";

// OTLP over HTTP from applications, at /api/ingest/v1/{logs,traces,metrics}.
// The key decides the workspace. Its organization ID is stamped as the
// collector request's x-superlog-project-id header, and the collector writes
// it onto every resource as superlog.project_id, replacing any superlog.*
// attribute the application sent.
//
// Browsers send OTLP straight from the page, so the OTLP routes answer CORS
// requests from any origin. The ingest key only adds telemetry to its
// workspace, and no response carries workspace data.
//
// Cloud providers that deliver in their own formats are converted to OTLP
// first: Vercel log drains at /api/ingest/vercel/logs, and AWS Firehose
// streams of CloudWatch metrics and logs at /api/ingest/aws/firehose/*.
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
// Decompressed request bodies larger than this are refused.
const maxDecompressedBytes = 64 * 1024 * 1024;

// The request body, decompressed when it was sent with gzip.
async function requestBody(request: Request): Promise<Buffer> {
  const body = Buffer.from(await request.arrayBuffer());
  return request.headers.get("content-encoding")?.toLowerCase() === "gzip"
    ? gunzipSync(body, { maxOutputLength: maxDecompressedBytes })
    : body;
}

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

  async function forward(input: {
    body: ArrayBuffer | Uint8Array<ArrayBuffer> | string;
    collector: string;
    contentEncoding?: string | null;
    contentType: string;
    organizationId: string;
    signal: string;
  }): Promise<Response | null> {
    const headers = new Headers({ "content-type": input.contentType, "x-superlog-project-id": input.organizationId });
    if (input.contentEncoding) headers.set("content-encoding", input.contentEncoding);
    try {
      return await dependencies.forward(`${input.collector}/v1/${input.signal}`, {
        body: input.body,
        headers,
        method: "POST",
      });
    } catch (error) {
      console.warn(JSON.stringify({ error: error instanceof Error ? error.message : String(error), event: "telemetry_ingest_forward_failed" }));
      return null;
    }
  }

  return new Hono()
    .use(
      "/v1/*",
      cors({
        allowHeaders: ["authorization", "content-encoding", "content-type", "traceparent", "tracestate", "x-api-key"],
        allowMethods: ["POST", "OPTIONS"],
        exposeHeaders: ["retry-after"],
        maxAge: 86_400,
        origin: "*",
      }),
    )
    .post("/v1/:signal", async (context) => {
      const signal = context.req.param("signal");
      const collector = dependencies.collectorUrl();
      if (!collector || !signals.has(signal)) return context.json({ error: "Not found" }, 404);
      const token = bearerToken(context.req.raw.headers);
      const key = token ? await workspaceFor(token) : null;
      if (!key) return context.json({ error: "Send a valid ingest key as Authorization: Bearer <key>" }, 401);

      const response = await forward({
        body: await context.req.arrayBuffer(),
        collector,
        contentEncoding: context.req.header("content-encoding"),
        contentType: context.req.header("content-type") ?? "application/x-protobuf",
        organizationId: key.organizationId,
        signal,
      });
      if (!response) return context.json({ error: "Telemetry ingest is unavailable" }, 503);
      void dependencies.recordUse(key.keyId).catch(() => undefined);
      // The collector's answer, such as a partial success or a retry hint.
      const answer = new Headers({ "content-type": response.headers.get("content-type") ?? "application/json" });
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter) answer.set("retry-after", retryAfter);
      return new Response(response.body, { headers: answer, status: response.status });
    })
    // Vercel log drains: JSON or NDJSON records, with the key in x-api-key.
    .post("/vercel/logs", async (context) => {
      const collector = dependencies.collectorUrl();
      if (!collector) return context.json({ error: "Not found" }, 404);
      const token = bearerToken(context.req.raw.headers);
      const key = token ? await workspaceFor(token) : null;
      if (!key) return context.json({ error: "Send a valid ingest key as x-api-key" }, 401);
      let payload: ReturnType<typeof vercelLogsToOtlp>;
      try {
        const body = await requestBody(context.req.raw);
        payload = vercelLogsToOtlp(parseVercelLogs(body.toString("utf8"), context.req.header("content-type") ?? ""));
      } catch {
        return context.json({ error: "Send Vercel log drain records as JSON or NDJSON" }, 400);
      }
      if (payload.resourceLogs.length > 0) {
        const response = await forward({ body: JSON.stringify(payload), collector, contentType: "application/json", organizationId: key.organizationId, signal: "logs" });
        if (!response?.ok) return context.json({ error: "Telemetry ingest is unavailable" }, 503);
      }
      void dependencies.recordUse(key.keyId).catch(() => undefined);
      return context.body(null, 200);
    })
    // Firehose HTTP endpoint deliveries from the AWS telemetry stack. Firehose
    // retries any answer other than 200 for up to its retry duration.
    .post("/aws/firehose/:signal", async (context) => {
      const signal = context.req.param("signal");
      const collector = dependencies.collectorUrl();
      if (!collector || (signal !== "logs" && signal !== "metrics")) return context.json({ error: "Not found" }, 404);
      const headerRequestId = context.req.header("x-amz-firehose-request-id") ?? "";
      const reply = (status: 200 | 400 | 401 | 503, errorMessage?: string, requestId = headerRequestId) =>
        context.json(firehoseAnswer(requestId, errorMessage, dependencies.now()), status);
      const token = context.req.header("x-amz-firehose-access-key")?.trim();
      const key = token ? await workspaceFor(token) : null;
      if (!key) return reply(401, "Invalid Superlog ingest key in the Firehose access key");
      let request: ReturnType<typeof firehoseRequestSchema.parse>;
      try {
        request = firehoseRequestSchema.parse(JSON.parse((await requestBody(context.req.raw)).toString("utf8")));
      } catch {
        return reply(400, "Invalid Firehose request body");
      }
      const requestId = headerRequestId || request.requestId;
      let response: Response | null = null;
      try {
        if (signal === "metrics") {
          const body = metricStreamRequest(request);
          if (body.length > 0) {
            response = await forward({ body, collector, contentType: "application/x-protobuf", organizationId: key.organizationId, signal });
            if (!response) return reply(503, "Telemetry ingest is unavailable", requestId);
          }
        } else {
          const logs = cloudWatchLogsToOtlp(request, firehoseSource(context.req.header("x-amz-firehose-source-arn")), dependencies.now());
          if (logs.records > 0) {
            response = await forward({ body: JSON.stringify(logs.payload), collector, contentType: "application/json", organizationId: key.organizationId, signal });
            if (!response) return reply(503, "Telemetry ingest is unavailable", requestId);
          }
        }
      } catch (error) {
        return reply(400, error instanceof Error ? error.message : "Invalid Firehose records", requestId);
      }
      // A rejected payload will not succeed on retry; a busy collector will.
      if (response && !response.ok) {
        return response.status >= 500 || response.status === 429
          ? reply(503, `Telemetry ingest answered HTTP ${response.status}`, requestId)
          : reply(400, `Telemetry ingest rejected the records with HTTP ${response.status}`, requestId);
      }
      void dependencies.recordUse(key.keyId).catch(() => undefined);
      return reply(200, undefined, requestId);
    });
}
