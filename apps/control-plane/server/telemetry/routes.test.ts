import { describe, expect, it, vi } from "vitest";
import { createTelemetryRoutes, type TelemetryRouteDependencies } from "./routes.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const projectId = "b925b1df-5b78-43c8-a816-6f00afb174af";
const now = new Date("2026-10-13T12:00:00.000Z");

function routes(overrides: Partial<TelemetryRouteDependencies> = {}) {
  const dependencies: TelemetryRouteDependencies = {
    client: () => ({}) as never,
    findProject: vi.fn(async () => ({ name: "Default", projectId })),
    hasTelemetry: vi.fn(async () => true),
    listProjects: vi.fn(async () => [{ name: "Default", projectId }]),
    listServices: vi.fn(async () => ["checkout", "api"]),
    now: () => now,
    queryLogs: vi.fn(async () => [{ body: "hello", service: "checkout" }]),
    tenant: vi.fn(async () => ({ ok: true as const, organizationId })),
    ...overrides,
  };
  return { app: createTelemetryRoutes(dependencies), dependencies };
}

describe("telemetry routes", () => {
  it("lists the workspace's linked projects", async () => {
    const { app } = routes();

    const response = await app.request("/projects");

    await expect(response.json()).resolves.toEqual({
      projects: [{ name: "Default", projectId }],
    });
  });

  it("queries logs of a linked project with the chosen filters and window", async () => {
    const { app, dependencies } = routes();

    const response = await app.request(
      `/logs?projectId=${projectId}&range=15m&service=checkout&severity=ERROR&search=timeout&limit=50`,
    );

    await expect(response.json()).resolves.toEqual({
      logs: [{ body: "hello", service: "checkout" }],
    });
    expect(dependencies.findProject).toHaveBeenCalledWith(organizationId, projectId);
    expect(dependencies.queryLogs).toHaveBeenCalledWith(expect.anything(), projectId, {
      limit: 50,
      range: { since: "2026-10-13T11:45:00.000Z", until: "2026-10-13T12:00:00.000Z" },
      search: "timeout",
      service: "checkout",
      severity: "ERROR",
    });
  });

  it("lists services seen in a linked project's window", async () => {
    const { app, dependencies } = routes();

    const response = await app.request(`/services?projectId=${projectId}&range=24h`);

    await expect(response.json()).resolves.toEqual({ services: ["checkout", "api"] });
    expect(dependencies.listServices).toHaveBeenCalledWith(expect.anything(), projectId, {
      since: "2026-10-12T12:00:00.000Z",
      until: "2026-10-13T12:00:00.000Z",
    });
  });

  it("does not read a project the workspace has not linked", async () => {
    const { app, dependencies } = routes({ findProject: vi.fn(async () => null) });

    const response = await app.request(`/logs?projectId=${projectId}`);

    expect(response.status).toBe(404);
    expect(dependencies.queryLogs).not.toHaveBeenCalled();
  });

  it("hides telemetry from a workspace without the capability or a configured store", async () => {
    for (const overrides of [
      { hasTelemetry: vi.fn(async () => false) },
      { client: () => null },
    ]) {
      const { app, dependencies } = routes(overrides);

      expect((await app.request("/projects")).status).toBe(404);
      expect((await app.request(`/logs?projectId=${projectId}`)).status).toBe(404);
      expect(dependencies.queryLogs).not.toHaveBeenCalled();
    }
  });

  it("rejects unknown ranges, oversized limits, and malformed project IDs", async () => {
    const { app } = routes();

    for (const query of [
      `projectId=${projectId}&range=90d`,
      `projectId=${projectId}&limit=5000`,
      "projectId=not-a-uuid",
    ]) {
      expect((await app.request(`/logs?${query}`)).status).toBe(400);
    }
  });

  it("passes the tenant failure through", async () => {
    const { app } = routes({
      tenant: vi.fn(async () => ({ error: "Unauthorized", ok: false as const, status: 401 as const })),
    });

    expect((await app.request("/projects")).status).toBe(401);
  });
});
