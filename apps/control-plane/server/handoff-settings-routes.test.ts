import { describe, expect, it, vi } from "vitest";
import { createHandoffSettingsRoutes } from "./handoff-settings-routes.js";
import type { HandoffTarget } from "../../../packages/core/src/ide-handoff.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
function setup(role = "admin") {
  let saved: HandoffTarget[] = ["conductor"];
  const deps: NonNullable<Parameters<typeof createHandoffSettingsRoutes>[0]> = {
    tenant: vi.fn(async () => ({ ok: true as const, role, organizationId, user: { id: "user", name: "Ash", email: "ash@example.com" } })) as never,
    get: vi.fn(async () => saved),
    save: vi.fn(async (_: string, targets: HandoffTarget[]) => { saved = targets; }),
  };
  return { deps, app: createHandoffSettingsRoutes(deps) };
}
const put = (app: ReturnType<typeof createHandoffSettingsRoutes>, body: unknown) =>
  app.request("/", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("handoff settings", () => {
  it("lets members read the workspace's buttons", async () => {
    const { app } = setup("member");
    expect(await (await app.request("/")).json()).toEqual({ canEdit: false, targets: ["conductor"] });
  });

  it("saves known buttons in a fixed order, including none", async () => {
    const { app, deps } = setup();
    const response = await put(app, { targets: ["prompt", "capy", "claude"] });
    expect(response.status).toBe(200);
    expect(deps.save).toHaveBeenCalledWith(organizationId, ["claude", "capy", "prompt"]);
    expect(await response.json()).toEqual({ canEdit: true, targets: ["claude", "capy", "prompt"] });
    expect((await put(app, { targets: [] })).status).toBe(200);
    expect(deps.save).toHaveBeenLastCalledWith(organizationId, []);
  });

  it("rejects unknown buttons", async () => {
    const { app, deps } = setup();
    expect((await put(app, { targets: ["cursor"] })).status).toBe(400);
    expect((await put(app, null)).status).toBe(400);
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("lets only administrators change them", async () => {
    const { app, deps } = setup("member");
    expect((await put(app, { targets: ["codex"] })).status).toBe(403);
    expect(deps.save).not.toHaveBeenCalled();
  });
});
