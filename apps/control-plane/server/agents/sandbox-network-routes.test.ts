import { describe, expect, it, vi } from "vitest";
import { createSandboxNetworkRoutes } from "./sandbox-network-routes.js";
import { defaultSandboxNetworkSettings } from "../../../../packages/core/src/sandbox-network.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";

function setup(role = "admin") {
  const deps: NonNullable<Parameters<typeof createSandboxNetworkRoutes>[0]> = {
    applicationUrl: () => "https://superlog.sh",
    get: vi.fn(async () => defaultSandboxNetworkSettings),
    save: vi.fn(async () => {}),
    tenant: vi.fn(async () => ({
      ok: true as const,
      organizationId,
      role,
      user: { email: "ash@example.com", id: userId, name: "Ash" },
    })),
  };
  return { app: createSandboxNetworkRoutes(deps), deps };
}

function put(app: ReturnType<typeof createSandboxNetworkRoutes>, body: unknown) {
  return app.request("/", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
}

describe("sandbox network settings", () => {
  it("shows members the settings and Superlog's host, without editing", async () => {
    const { app } = setup("member");
    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      alwaysAllowed: ["superlog.sh"],
      canEdit: false,
      settings: defaultSandboxNetworkSettings,
    });
  });

  it("saves a normalized list for the active workspace", async () => {
    const { app, deps } = setup();
    const response = await put(app, { allowedDomains: ["Registry.npmjs.org", "registry.npmjs.org"], restricted: true });
    expect(response.status).toBe(200);
    expect(deps.save).toHaveBeenCalledWith(
      organizationId,
      { allowedDomains: ["registry.npmjs.org"], restricted: true },
      userId,
    );
  });

  it("rejects a URL in place of a domain", async () => {
    const { app, deps } = setup();
    const response = await put(app, { allowedDomains: ["https://example.com"], restricted: true });
    expect(response.status).toBe(400);
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("lets only owners and admins change it", async () => {
    const { app, deps } = setup("member");
    expect((await put(app, { allowedDomains: [], restricted: true })).status).toBe(403);
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    const { app, deps } = setup();
    vi.mocked(deps.tenant).mockResolvedValue({ error: "Unauthorized", ok: false, status: 401 });
    expect((await app.request("/")).status).toBe(401);
  });
});
