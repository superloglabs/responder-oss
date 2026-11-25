import { describe, expect, it, vi } from "vitest";
import { createPullRequestApprovalRoutes } from "./pull-request-approval-routes.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
function setup(role = "admin") {
  let saved = false;
  const deps: NonNullable<Parameters<typeof createPullRequestApprovalRoutes>[0]> = {
    tenant: vi.fn(async () => ({ ok: true as const, role, organizationId, user: { id: "user", name: "Ash", email: "ash@example.com" } })) as never,
    get: vi.fn(async () => saved),
    save: vi.fn(async (_: string, requireApproval: boolean) => { saved = requireApproval; }),
  };
  return { deps, app: createPullRequestApprovalRoutes(deps) };
}
const put = (app: ReturnType<typeof createPullRequestApprovalRoutes>, body: unknown) =>
  app.request("/", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("pull request approval settings", () => {
  it("is off by default and readable by members", async () => {
    const { app } = setup("member");
    expect(await (await app.request("/")).json()).toEqual({ canEdit: false, requireApproval: false });
  });

  it("lets administrators turn it on and off", async () => {
    const { app, deps } = setup();
    const response = await put(app, { requireApproval: true });
    expect(response.status).toBe(200);
    expect(deps.save).toHaveBeenCalledWith(organizationId, true);
    expect(await response.json()).toEqual({ canEdit: true, requireApproval: true });
    expect((await put(app, { requireApproval: false })).status).toBe(200);
    expect(deps.save).toHaveBeenLastCalledWith(organizationId, false);
  });

  it("rejects anything but a boolean", async () => {
    const { app, deps } = setup();
    expect((await put(app, { requireApproval: "yes" })).status).toBe(400);
    expect((await put(app, null)).status).toBe(400);
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("lets only administrators change it", async () => {
    const { app, deps } = setup("member");
    expect((await put(app, { requireApproval: true })).status).toBe(403);
    expect(deps.save).not.toHaveBeenCalled();
  });
});
