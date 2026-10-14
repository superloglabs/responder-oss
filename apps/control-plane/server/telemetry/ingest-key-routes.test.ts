import { describe, expect, it, vi } from "vitest";
import { createIngestKeyRoutes, type IngestKeyRouteDependencies } from "./ingest-key-routes.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const keyId = "11111111-1111-4111-8111-111111111111";
const key = {
  createdAt: "2026-10-14T12:00:00.000Z",
  id: keyId,
  lastUsedAt: null,
  name: "Production",
  prefix: "sl_ingest_abcdef",
  projectId: "b925b1df-5b78-43c8-a816-6f00afb174af",
  projectName: "Default",
};

function routes(overrides: Partial<IngestKeyRouteDependencies> = {}) {
  const dependencies: IngestKeyRouteDependencies = {
    collectorUrl: () => "http://collector:4318",
    createKey: vi.fn(async () => ({ key, token: "sl_ingest_secret" })),
    hasTelemetry: vi.fn(async () => true),
    listKeys: vi.fn(async () => [key]),
    revokeKey: vi.fn(async () => true),
    tenant: vi.fn(async () => ({ ok: true as const, organizationId, user: { id: userId } })),
    ...overrides,
  };
  return { app: createIngestKeyRoutes(dependencies), dependencies };
}

describe("ingest key routes", () => {
  it("lists, creates and revokes keys", async () => {
    const { app, dependencies } = routes();

    expect(await (await app.request("/")).json()).toEqual({ keys: [key] });
    const created = await app.request("/", {
      body: JSON.stringify({ name: "Production" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ key, token: "sl_ingest_secret" });
    expect(dependencies.createKey).toHaveBeenCalledWith({ createdBy: userId, name: "Production", organizationId });
    expect((await app.request(`/${keyId}`, { method: "DELETE" })).status).toBe(204);
    expect(dependencies.revokeKey).toHaveBeenCalledWith(organizationId, keyId);
  });

  it("rejects unnamed keys and another workspace's project", async () => {
    const { app } = routes({ createKey: vi.fn(async () => null) });
    const post = (body: unknown) =>
      app.request("/", { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" });

    expect((await post({ name: " " })).status).toBe(400);
    expect((await post({ name: "x", projectId: "b925b1df-5b78-43c8-a816-6f00afb174af" })).status).toBe(404);
  });

  it("is not there without telemetry or a collector", async () => {
    for (const overrides of [{ hasTelemetry: vi.fn(async () => false) }, { collectorUrl: () => null }]) {
      const { app, dependencies } = routes(overrides);
      expect((await app.request("/")).status).toBe(404);
      expect(dependencies.listKeys).not.toHaveBeenCalled();
    }
  });
});
