import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createIngestRoutes, type IngestRouteDependencies } from "./ingest-routes.js";

const token = `sl_ingest_${"a".repeat(43)}`;
const organizationId = "b925b1df-5b78-43c8-a816-6f00afb174af";

function routes(overrides: Partial<IngestRouteDependencies> = {}) {
  let now = 0;
  const dependencies: IngestRouteDependencies = {
    collectorUrl: () => "http://collector.telemetry.internal:4318",
    findKey: vi.fn(async () => ({ keyId: "key-1", lastUsedAt: null, organizationId })),
    forward: vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" }, status: 200 })),
    now: () => now,
    recordUse: vi.fn(async () => undefined),
    ...overrides,
  };
  return { advance: (ms: number) => { now += ms; }, app: createIngestRoutes(dependencies), dependencies };
}

function send(app: ReturnType<typeof routes>["app"], path: string, headers: Record<string, string> = { authorization: `Bearer ${token}` }) {
  return app.request(path, {
    body: new Uint8Array([10, 1, 2]),
    headers: { "content-encoding": "gzip", "content-type": "application/x-protobuf", ...headers },
    method: "POST",
  });
}

describe("telemetry ingest", () => {
  it("forwards the body to the collector with the key's workspace", async () => {
    const { app, dependencies } = routes();

    const response = await send(app, "/v1/traces");

    expect(response.status).toBe(200);
    const [url, init] = vi.mocked(dependencies.forward).mock.calls[0]!;
    expect(url).toBe("http://collector.telemetry.internal:4318/v1/traces");
    const headers = init!.headers as Headers;
    expect(headers.get("x-superlog-project-id")).toBe(organizationId);
    expect(headers.get("content-encoding")).toBe("gzip");
    expect(headers.get("content-type")).toBe("application/x-protobuf");
    expect(new Uint8Array(init!.body as ArrayBuffer)).toEqual(new Uint8Array([10, 1, 2]));
    expect(dependencies.recordUse).toHaveBeenCalledWith("key-1");
  });

  it("accepts the key in x-api-key and reuses a lookup for a minute", async () => {
    const { advance, app, dependencies } = routes();

    expect((await send(app, "/v1/logs", { "x-api-key": token })).status).toBe(200);
    expect((await send(app, "/v1/metrics")).status).toBe(200);
    expect(dependencies.findKey).toHaveBeenCalledTimes(1);
    advance(61_000);
    await send(app, "/v1/logs");
    expect(dependencies.findKey).toHaveBeenCalledTimes(2);
  });

  it("rejects missing or unknown keys without forwarding", async () => {
    const { app, dependencies } = routes({ findKey: vi.fn(async () => null) });

    expect((await send(app, "/v1/logs", {})).status).toBe(401);
    expect((await send(app, "/v1/logs")).status).toBe(401);
    expect(dependencies.forward).not.toHaveBeenCalled();
  });

  it("passes the collector's answer through and reports an unreachable collector", async () => {
    const throttled = routes({
      forward: vi.fn(async () => new Response("slow down", { headers: { "retry-after": "5" }, status: 503 })),
    });
    const response = await send(throttled.app, "/v1/logs");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");

    const down = routes({ forward: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) });
    expect((await send(down.app, "/v1/logs")).status).toBe(503);
  });

  it("is not there without a collector or for other signals", async () => {
    expect((await send(routes({ collectorUrl: () => null }).app, "/v1/logs")).status).toBe(404);
    expect((await send(routes().app, "/v1/profiles")).status).toBe(404);
  });
});

describe("Vercel log drain ingest", () => {
  it("converts NDJSON records to OTLP logs for the key's project", async () => {
    const { app, dependencies } = routes();
    const records = [{ level: "info", message: "hello", projectName: "shop", timestamp: 1 }, { message: "again", projectName: "shop", timestamp: 2 }];

    const response = await app.request("/vercel/logs", {
      body: gzipSync(records.map((record) => JSON.stringify(record)).join("\n")),
      headers: { "content-encoding": "gzip", "content-type": "application/x-ndjson", "x-api-key": token },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const [url, init] = vi.mocked(dependencies.forward).mock.calls[0]!;
    expect(url).toBe("http://collector.telemetry.internal:4318/v1/logs");
    expect((init!.headers as Headers).get("content-type")).toBe("application/json");
    expect((init!.headers as Headers).get("x-superlog-project-id")).toBe(organizationId);
    const body = JSON.parse(init!.body as string);
    expect(body.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(2);
    expect(dependencies.recordUse).toHaveBeenCalledWith("key-1");
  });

  it("rejects bad keys and bodies", async () => {
    const { app, dependencies } = routes({ findKey: vi.fn(async () => null) });
    expect((await app.request("/vercel/logs", { body: "[]", headers: { "x-api-key": token }, method: "POST" })).status).toBe(401);
    const valid = routes();
    expect((await valid.app.request("/vercel/logs", { body: "{", headers: { "x-api-key": token }, method: "POST" })).status).toBe(400);
    expect(dependencies.forward).not.toHaveBeenCalled();
  });
});

describe("AWS Firehose ingest", () => {
  function firehose(app: ReturnType<typeof routes>["app"], signal: string, records: Array<{ data: string }>, headers: Record<string, string> = {}) {
    return app.request(`/aws/firehose/${signal}`, {
      body: gzipSync(JSON.stringify({ records, requestId: "body-id", timestamp: 1 })),
      headers: {
        "content-encoding": "gzip",
        "content-type": "application/json",
        "x-amz-firehose-access-key": token,
        "x-amz-firehose-request-id": "req-1",
        "x-amz-firehose-source-arn": "arn:aws:firehose:eu-west-1:123456789012:deliverystream/superlog-ab-logs",
        ...headers,
      },
      method: "POST",
    });
  }

  it("forwards metric stream messages as one OTLP protobuf request", async () => {
    const { app, dependencies } = routes();
    const data = Buffer.from([2, 10, 0, 1, 10]).toString("base64");

    const response = await firehose(app, "metrics", [{ data }]);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ requestId: "req-1", timestamp: 0 });
    const [url, init] = vi.mocked(dependencies.forward).mock.calls[0]!;
    expect(url).toBe("http://collector.telemetry.internal:4318/v1/metrics");
    expect((init!.headers as Headers).get("content-type")).toBe("application/x-protobuf");
    expect([...(init!.body as Uint8Array)]).toEqual([10, 0, 10]);
  });

  it("converts CloudWatch Logs records and stamps the stream's region", async () => {
    const { app, dependencies } = routes();
    const data = gzipSync(JSON.stringify({
      logEvents: [{ id: "1", message: "ERROR boom", timestamp: 1 }],
      logGroup: "/aws/lambda/checkout",
      logStream: "s",
      messageType: "DATA_MESSAGE",
      owner: "123456789012",
    })).toString("base64");

    expect((await firehose(app, "logs", [{ data }])).status).toBe(200);
    const body = JSON.parse(vi.mocked(dependencies.forward).mock.calls[0]![1]!.body as string);
    expect(body.resourceLogs[0].resource.attributes).toContainEqual({ key: "cloud.region", value: { stringValue: "eu-west-1" } });
  });

  it("answers Firehose errors with the request ID", async () => {
    const unknown = routes({ findKey: vi.fn(async () => null) });
    const denied = await firehose(unknown.app, "logs", []);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ errorMessage: expect.any(String), requestId: "req-1" });

    const busy = routes({ forward: vi.fn(async () => new Response("", { status: 503 })) });
    const data = Buffer.from([1, 10]).toString("base64");
    expect((await firehose(busy.app, "metrics", [{ data }])).status).toBe(503);

    expect((await firehose(routes().app, "traces", [])).status).toBe(404);
  });

  it("acknowledges a delivery with nothing to send", async () => {
    const { app, dependencies } = routes();
    expect((await firehose(app, "logs", [])).status).toBe(200);
    expect(dependencies.forward).not.toHaveBeenCalled();
  });
});
