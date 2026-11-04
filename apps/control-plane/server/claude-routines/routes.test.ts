import { describe, expect, it, vi } from "vitest";
import { ClaudeRoutineFireError } from "../../../../packages/core/src/claude-routines.js";
import { createClaudeRoutineRoutes, type ClaudeRoutineRouteDependencies } from "./routes.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const routineId = "00000000-0000-4000-8000-000000000003";
const routine = {
  createdAt: "2026-11-04T00:00:00.000Z", id: routineId, lastError: null, lastFiredAt: null, name: "Triage", triggerId: "trig_01ABC",
};
const fireUrl = "https://api.anthropic.com/v1/claude_code/routines/trig_01ABC/fire";

function routes(role = "admin", overrides: Partial<ClaudeRoutineRouteDependencies> = {}) {
  const dependencies: ClaudeRoutineRouteDependencies = {
    create: vi.fn(async () => routine),
    delete: vi.fn(async () => true),
    hasTelemetry: vi.fn(async () => true),
    list: vi.fn(async () => [routine]),
    start: vi.fn(async () => ({ sessionUrl: "https://claude.ai/code/session_01" })),
    tenant: vi.fn(async () => ({ ok: true as const, organizationId, role, user: { id: userId } })),
    ...overrides,
  };
  return { app: createClaudeRoutineRoutes(dependencies), dependencies };
}

function post(app: ReturnType<typeof routes>["app"], path: string, body?: unknown) {
  return app.request(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
}

describe("Claude routine routes", () => {
  it("lists routines to any member without their tokens", async () => {
    const { app } = routes("member");
    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ routines: [routine] });
  });

  it("adds a routine from its Fire URL and token", async () => {
    const { app, dependencies } = routes();
    const response = await post(app, "/", { fireUrl, name: " Triage ", token: " sk-ant-oat01-secret " });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ routine });
    expect(dependencies.create).toHaveBeenCalledWith(organizationId, {
      createdBy: userId, name: "Triage", token: "sk-ant-oat01-secret", triggerId: "trig_01ABC",
    });
  });

  it("rejects a URL that is not a routine's Fire URL", async () => {
    const { app, dependencies } = routes();
    const response = await post(app, "/", { fireUrl: "https://example.com/hook", name: "Hook", token: "secret" });
    expect(response.status).toBe(400);
    expect(dependencies.create).not.toHaveBeenCalled();
  });

  it("lets only owners and admins add, test, and remove routines", async () => {
    const { app, dependencies } = routes("member");
    expect((await post(app, "/", { fireUrl, name: "Triage", token: "secret" })).status).toBe(403);
    expect((await post(app, `/${routineId}/test`)).status).toBe(403);
    expect((await app.request(`/${routineId}`, { method: "DELETE" })).status).toBe(403);
    expect(dependencies.create).not.toHaveBeenCalled();
    expect(dependencies.start).not.toHaveBeenCalled();
    expect(dependencies.delete).not.toHaveBeenCalled();
  });

  it("starts a test session and reports Anthropic's refusal", async () => {
    const { app, dependencies } = routes();
    const response = await post(app, `/${routineId}/test`);
    expect(await response.json()).toEqual({ sessionUrl: "https://claude.ai/code/session_01" });
    expect(dependencies.start).toHaveBeenCalledWith({ organizationId, routineId, text: expect.stringContaining("This is a test from Superlog") });

    const refused = routes("admin", {
      start: vi.fn(async () => {
        throw new ClaudeRoutineFireError("The routine token was rejected", false);
      }),
    });
    const failure = await post(refused.app, `/${routineId}/test`);
    expect(failure.status).toBe(502);
    expect(await failure.json()).toEqual({ error: "The routine token was rejected" });
  });

  it("removes a routine of the workspace", async () => {
    const { app, dependencies } = routes();
    expect((await app.request(`/${routineId}`, { method: "DELETE" })).status).toBe(204);
    expect(dependencies.delete).toHaveBeenCalledWith(organizationId, routineId);
    const missing = routes("admin", { delete: vi.fn(async () => false) });
    expect((await missing.app.request(`/${routineId}`, { method: "DELETE" })).status).toBe(404);
  });

  it("is unavailable without telemetry", async () => {
    const { app } = routes("admin", { hasTelemetry: vi.fn(async () => false) });
    expect((await app.request("/")).status).toBe(404);
  });
});
