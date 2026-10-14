import { describe, expect, it, vi } from "vitest";
import { createIngestRoutes, type IngestRouteDependencies } from "./ingest-routes.js";

const token = `sl_ingest_${"a".repeat(43)}`;
const projectId = "b925b1df-5b78-43c8-a816-6f00afb174af";

function routes(overrides: Partial<IngestRouteDependencies> = {}) {
  let now = 0;
  const dependencies: IngestRouteDependencies = {
    collectorUrl: () => "http://collector.telemetry.internal:4318",
    findKey: vi.fn(async () => ({ keyId: "key-1", lastUsedAt: null, organizationId: "org-1", projectId })),
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
  it("forwards the body to the collector with the key's project", async () => {
    const { app, dependencies } = routes();

    const response = await send(app, "/v1/traces");

    expect(response.status).toBe(200);
    const [url, init] = vi.mocked(dependencies.forward).mock.calls[0]!;
    expect(url).toBe("http://collector.telemetry.internal:4318/v1/traces");
    const headers = init!.headers as Headers;
    expect(headers.get("x-superlog-project-id")).toBe(projectId);
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
