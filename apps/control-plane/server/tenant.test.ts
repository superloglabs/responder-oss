import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/hono/node";
import { getActiveTenant } from "./tenant.js";

const auth = vi.hoisted(() => ({ getSession: vi.fn(), getActiveMember: vi.fn() }));
vi.mock("./auth.js", () => ({ getAuth: () => ({ api: auth }) }));
vi.mock("@sentry/hono/node", () => ({ setUser: vi.fn(), setTag: vi.fn() }));

describe("tenant error identity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("attaches the authenticated user and verified organization", async () => {
    auth.getSession.mockResolvedValue({
      user: { id: "user-1", name: "Ada", email: "ada@example.com" },
      session: { activeOrganizationId: "org-1" },
    });
    auth.getActiveMember.mockResolvedValue({ userId: "user-1", organizationId: "org-1" });
    expect((await getActiveTenant(new Headers())).ok).toBe(true);
    expect(Sentry.setUser).toHaveBeenCalledWith({ id: "user-1", username: "Ada" });
    expect(Sentry.setTag).toHaveBeenCalledWith("organization_id", "org-1");
  });

  it("leaves signed-out requests without user or organization identity", async () => {
    auth.getSession.mockResolvedValue(null);
    expect(await getActiveTenant(new Headers())).toEqual({ ok: false, error: "Unauthorized", status: 401 });
    expect(Sentry.setUser).not.toHaveBeenCalled();
    expect(Sentry.setTag).not.toHaveBeenCalled();
  });

  it("keeps user identity when no organization is selected", async () => {
    auth.getSession.mockResolvedValue({
      user: { id: "user-1", name: "Ada" }, session: {},
    });
    expect(await getActiveTenant(new Headers())).toEqual({ ok: false, error: "No active organization", status: 409 });
    expect(Sentry.setUser).toHaveBeenCalledWith({ id: "user-1", username: "Ada" });
    expect(Sentry.setTag).not.toHaveBeenCalled();
  });

  it("does not attach an organization the user cannot access", async () => {
    auth.getSession.mockResolvedValue({
      user: { id: "user-1", name: "Ada" },
      session: { activeOrganizationId: "org-2" },
    });
    auth.getActiveMember.mockResolvedValue({ userId: "user-1", organizationId: "org-1" });
    expect((await getActiveTenant(new Headers())).ok).toBe(false);
    expect(Sentry.setUser).toHaveBeenCalledWith({ id: "user-1", username: "Ada" });
    expect(Sentry.setTag).not.toHaveBeenCalled();
  });
});
