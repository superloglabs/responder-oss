import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderApiError } from "../../../../packages/core/src/integrations/render.js";
import { createRenderConnectionRoutes, type RenderConnectionDependencies } from "./render.js";

const organizationId = "b925b1df-5b78-43c8-a816-6f00afb174af";
const accountId = "3f1f2a1e-8d47-4a5e-9c55-0b0c3ad3b0aa";
const apiKey = "rnd_example_key_123";

function routes(overrides: Partial<RenderConnectionDependencies> = {}) {
  const dependencies: RenderConnectionDependencies = {
    capture: vi.fn(async () => undefined),
    encrypt: vi.fn(() => "sealed"),
    save: vi.fn(async () => accountId),
    tenant: vi.fn(async () => ({ ok: true as const, organizationId, role: "member", user: { id: "user-1" } })) as unknown as RenderConnectionDependencies["tenant"],
    user: vi.fn(async () => ({ email: "Dev@Example.com", name: "Dev" })),
    workspaces: vi.fn(async () => [{ id: "tea-example", name: "Example Team" }]),
    ...overrides,
  };
  return { app: createRenderConnectionRoutes(dependencies), dependencies };
}

function connect(app: ReturnType<typeof routes>["app"], body: unknown) {
  return app.request("/connect", { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" });
}

describe("Render connection", () => {
  const logs: string[] = [];
  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_URL", "https://app.example.com");
    logs.length = 0;
    for (const method of ["info", "log", "error", "warn"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("checks the key, stores it encrypted, and names the connection after its user", async () => {
    const { app, dependencies } = routes();

    const response = await connect(app, { apiKey: ` ${apiKey} `, returnTo: "/signal/setup/telemetry/render" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { accountId: string; redirectUrl: string };
    expect(body.accountId).toBe(accountId);
    const redirect = new URL(body.redirectUrl);
    expect(redirect.origin).toBe("https://app.example.com");
    expect(redirect.pathname).toBe("/signal/setup/telemetry/render");
    expect(redirect.searchParams.get("integration")).toBe("render");
    expect(redirect.searchParams.get("integration_account_id")).toBe(accountId);
    expect(dependencies.workspaces).toHaveBeenCalledWith({ apiKey });
    expect(dependencies.encrypt).toHaveBeenCalledWith({ apiKey });
    expect(dependencies.save).toHaveBeenCalledWith({
      credentialKeyVersion: 1,
      displayName: "Dev@Example.com",
      encryptedCredentials: "sealed",
      externalAccountId: "dev@example.com",
      metadata: { workspaces: [{ id: "tea-example", name: "Example Team" }] },
      organizationId,
      provider: "render",
    });
    expect(JSON.stringify(body)).not.toContain(apiKey);
    expect(logs.join("\n")).not.toContain(apiKey);
  });

  it("names the connection after its workspaces when Render does not name the user", async () => {
    const { app, dependencies } = routes({
      user: vi.fn(async () => { throw new RenderApiError("Render answered 404: not found", "failed", 404); }),
      workspaces: vi.fn(async () => [{ id: "tea-1", name: "One" }, { id: "tea-2", name: "Two" }, { id: "tea-3", name: "Three" }]),
    });

    expect((await connect(app, { apiKey })).status).toBe(200);
    expect(dependencies.save).toHaveBeenCalledWith(expect.objectContaining({
      displayName: "One, Two and 1 more",
      externalAccountId: expect.stringMatching(/^key-[0-9a-f]{16}$/u),
    }));
  });

  it("says when Render rejects the key, and saves nothing", async () => {
    const { app, dependencies } = routes({
      workspaces: vi.fn(async () => { throw new RenderApiError("Render answered 401: unauthorized", "unauthorized", 401); }),
    });

    const response = await connect(app, { apiKey });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Render rejected this API key. Create one in Render's Account settings, under API Keys." });
    expect(dependencies.save).not.toHaveBeenCalled();
  });

  it("refuses an empty key, a key that reaches nothing, and an unreachable Render", async () => {
    expect((await connect(routes().app, { apiKey: "  " })).status).toBe(400);
    expect((await connect(routes({ workspaces: vi.fn(async () => []) }).app, { apiKey })).status).toBe(400);

    const unreachable = routes({ workspaces: vi.fn(async () => { throw new RenderApiError("Render could not be reached: timeout", "failed", null); }) });
    expect((await connect(unreachable.app, { apiKey })).status).toBe(502);
    expect(unreachable.dependencies.save).not.toHaveBeenCalled();
    expect(logs.join("\n")).not.toContain(apiKey);
  });
});
