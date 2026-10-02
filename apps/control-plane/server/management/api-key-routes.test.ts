import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiKeyRoutes } from "./api-key-routes.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const userId = "21212121-2121-4121-8121-212121212121";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const apiKeyId = "31313131-3131-4131-8131-313131313131";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  revoke: vi.fn(),
  tenant: vi.fn(),
}));

vi.mock("../tenant.js", () => ({ getActiveTenant: mocks.tenant }));
vi.mock("../../../../packages/core/src/db/api-keys.js", () => ({
  createApiKey: mocks.create,
  listApiKeys: mocks.list,
  revokeApiKey: mocks.revoke,
}));
vi.mock("../../../../packages/core/src/analytics.js", () => ({
  captureAnalyticsEvent: vi.fn().mockResolvedValue(undefined),
}));

const app = new Hono().route("/api/api-keys", apiKeyRoutes);
const user = { email: "ash@example.com", id: userId, name: "Ash" };

function signedIn(role: string) {
  mocks.tenant.mockResolvedValue({ ok: true, organizationId, role, user });
}

function key(createdBy: string) {
  return {
    createdAt: new Date("2026-10-02T10:00:00.000Z"),
    createdBy: { email: "x@example.com", id: createdBy, name: "X" },
    id: apiKeyId,
    lastUsedAt: null,
    name: "CI",
    prefix: "slk_abcdefgh",
  };
}

describe("API key settings routes", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requires a workspace session", async () => {
    mocks.tenant.mockResolvedValue({ error: "Unauthorized", ok: false, status: 401 });

    const response = await app.request("/api/api-keys");

    expect(response.status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("lets members revoke only their own keys", async () => {
    signedIn("member");
    mocks.list.mockResolvedValue([key(userId), key(otherUserId)]);

    const response = await app.request("/api/api-keys");
    const body = await response.json() as { apiKeys: Array<{ canRevoke: boolean }> };

    expect(body.apiKeys.map((item) => item.canRevoke)).toEqual([true, false]);
  });

  it("lets admins revoke every key", async () => {
    signedIn("admin");
    mocks.list.mockResolvedValue([key(otherUserId)]);

    const response = await app.request("/api/api-keys");
    const body = await response.json() as { apiKeys: Array<{ canRevoke: boolean }> };

    expect(body.apiKeys[0]?.canRevoke).toBe(true);
  });

  it("returns a new key once, without caching", async () => {
    signedIn("member");
    mocks.create.mockResolvedValue({ key: key(userId), token: "slk_secret" });

    const response = await app.request("/api/api-keys", {
      body: JSON.stringify({ name: " CI " }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ token: "slk_secret" });
    expect(mocks.create).toHaveBeenCalledWith({ name: "CI", organizationId, user });
  });

  it("revokes with the member's role", async () => {
    signedIn("member");
    mocks.revoke.mockResolvedValue(false);

    const response = await app.request(`/api/api-keys/${apiKeyId}`, { method: "DELETE" });

    expect(response.status).toBe(404);
    expect(mocks.revoke).toHaveBeenCalledWith({
      apiKeyId,
      organizationId,
      role: "member",
      userId,
    });
  });
});
