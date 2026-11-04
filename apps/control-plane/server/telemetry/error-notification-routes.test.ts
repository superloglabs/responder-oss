import { describe, expect, it, vi } from "vitest";
import { createErrorNotificationRoutes } from "./error-notification-routes.js";
import { defaultErrorNotificationSettings } from "../../../../packages/core/src/telemetry/error-notifications.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const accountId = "00000000-0000-4000-8000-000000000003";
const routine = {
  id: "00000000-0000-4000-8000-000000000004", name: "Triage", triggerId: "trig_01", createdAt: "2026-11-04T00:00:00.000Z", lastFiredAt: null, lastError: null,
};
function setup() {
  const deps: NonNullable<Parameters<typeof createErrorNotificationRoutes>[0]> = {
    tenant: vi.fn(async () => ({ ok: true as const, role: "admin", organizationId, user: { id: userId, name: "Ash", email: "ash@example.com" } })),
    hasCapability: vi.fn(async () => true),
    get: vi.fn(async () => defaultErrorNotificationSettings), save: vi.fn(async () => {}),
    channels: vi.fn(async () => [{ integrationAccountId: accountId, channelId: "C123", name: "errors", accountName: "Team", private: false }]),
    refresh: vi.fn(async () => undefined) as never,
    routines: vi.fn(async () => [routine]),
    findRoutine: vi.fn(async (_organizationId: string, id: string) => (id === routine.id ? routine : null)),
  };
  return { deps, app: createErrorNotificationRoutes(deps) };
}
const valid = { ...defaultErrorNotificationSettings, enabled: true, targets: [{ kind: "slack", integrationAccountId: accountId, channelId: "C123" }] };
function put(app: ReturnType<typeof createErrorNotificationRoutes>, body: unknown = valid) {
  return app.request("/", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
describe("error notification settings", () => {
  it("saves validated destinations in the active workspace", async () => {
    const { app, deps } = setup();
    expect((await put(app)).status).toBe(200);
    expect(deps.save).toHaveBeenCalledWith(organizationId, valid);
    expect(deps.channels).toHaveBeenCalledWith(organizationId);
  });
  it("rejects channels outside the workspace", async () => {
    const { app, deps } = setup();
    vi.mocked(deps.channels).mockResolvedValue([]);
    expect((await put(app)).status).toBe(400);
    expect(deps.save).not.toHaveBeenCalled();
  });
  it("can turn off notifications after a channel becomes unavailable", async () => {
    const { app, deps } = setup();
    vi.mocked(deps.channels).mockResolvedValue([]);
    expect((await put(app, { ...valid, enabled: false })).status).toBe(200);
  });
  it("requires administrator access for reads, writes, and refreshes", async () => {
    const { app, deps } = setup();
    const tenant = await deps.tenant(new Headers());
    if (!tenant.ok) throw new Error("fixture");
    vi.mocked(deps.tenant).mockResolvedValue({ ...tenant, role: "member" });
    expect((await app.request("/")).status).toBe(403);
    expect((await put(app)).status).toBe(403);
    expect((await app.request("/refresh-channels", { method: "POST" })).status).toBe(403);
    expect(deps.get).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
  });
  it("requires a session and telemetry capability", async () => {
    const { app, deps } = setup();
    vi.mocked(deps.hasCapability).mockResolvedValue(false);
    expect((await put(app)).status).toBe(404);
    vi.mocked(deps.tenant).mockResolvedValue({ ok: false, status: 401, error: "Unauthorized" });
    expect((await app.request("/")).status).toBe(401);
  });
  it("rejects enabled settings without a channel or with multiple channels", async () => {
    const { app, deps } = setup();
    expect((await put(app, { ...valid, targets: [] })).status).toBe(400);
    expect((await put(app, { ...valid, targets: [...valid.targets, ...valid.targets] })).status).toBe(400);
    expect(deps.save).not.toHaveBeenCalled();
  });
  it("saves a Claude routine from the workspace with or without a channel", async () => {
    const { app, deps } = setup();
    const routineTarget = { kind: "claude_routine", routineId: routine.id };
    expect((await put(app, { ...valid, targets: [routineTarget] })).status).toBe(200);
    expect((await put(app, { ...valid, targets: [...valid.targets, routineTarget] })).status).toBe(200);
    expect((await put(app, { ...valid, targets: [{ kind: "claude_routine", routineId: accountId }] })).status).toBe(400);
    expect(deps.save).toHaveBeenCalledTimes(2);
  });
  it("lists the workspace's routines with the settings", async () => {
    const { app } = setup();
    expect(await (await app.request("/")).json()).toMatchObject({ routines: [routine] });
  });
});
