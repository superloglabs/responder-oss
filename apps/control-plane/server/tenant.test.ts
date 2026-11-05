import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/hono/node";
import { getActiveTenant } from "./tenant.js";

const auth = vi.hoisted(() => ({ getSession: vi.fn(), getActiveMember: vi.fn() }));
const membership = vi.hoisted(() => vi.fn());
vi.mock("@responder/core/db/organizations", () => ({ getOrganizationMembership: membership }));
vi.mock("./auth.js", () => ({ getAuth: () => ({ api: auth }) }));
vi.mock("@sentry/hono/node", () => ({ setUser: vi.fn(), setTag: vi.fn() }));

describe("tenant error identity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("attaches the authenticated user and verified organization", async () => {
    auth.getSession.mockResolvedValue({
      user: { id: "user-1", name: "Ada", email: "ada@example.com" },
      session: { activeOrganizationId: "org-1" },
    });
    membership.mockResolvedValue({ userId: "user-1", organizationId: "org-1", role: "admin" });
    expect(await getActiveTenant(new Headers())).toEqual({
      ok: true, organizationId: "org-1", role: "admin",
      user: { id: "user-1", name: "Ada", email: "ada@example.com" },
    });
    expect(membership).toHaveBeenCalledWith("user-1", "org-1");
    expect(auth.getActiveMember).not.toHaveBeenCalled();
    expect(Sentry.setUser).toHaveBeenCalledWith({ id: "user-1", username: "Ada" });
    expect(Sentry.setTag).toHaveBeenCalledWith("organization_id", "org-1");
  });

  it("leaves signed-out requests without user or organization identity", async () => {
    auth.getSession.mockResolvedValue(null);
    expect(await getActiveTenant(new Headers())).toEqual({ ok: false, error: "Unauthorized", status: 401 });
    expect(membership).not.toHaveBeenCalled();
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
    membership.mockResolvedValue({ userId: "user-1", organizationId: "org-1", role: "admin" });
    expect((await getActiveTenant(new Headers())).ok).toBe(false);
    expect(Sentry.setUser).toHaveBeenCalledWith({ id: "user-1", username: "Ada" });
    expect(Sentry.setTag).not.toHaveBeenCalled();
  });
});

describe("stale workspace membership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.getSession.mockResolvedValue({
      user: { id: "user-1", name: "Ada" },
      session: { activeOrganizationId: "deleted-org" },
    });
  });

  it("denies a missing membership without invoking the throwing auth endpoint", async () => {
    membership.mockResolvedValue(null);
    expect(await getActiveTenant(new Headers())).toEqual({
      ok: false, error: "Organization access denied", status: 403,
    });
    expect(membership).toHaveBeenCalledWith("user-1", "deleted-org");
    expect(auth.getActiveMember).not.toHaveBeenCalled();
    expect(Sentry.setTag).not.toHaveBeenCalled();
  });

  it("does not disguise a database outage as a missing membership", async () => {
    const error = new Error("Database unavailable");
    membership.mockRejectedValue(error);
    await expect(getActiveTenant(new Headers())).rejects.toBe(error);
    expect(Sentry.setTag).not.toHaveBeenCalled();
  });

  it("denies a membership belonging to another user", async () => {
    membership.mockResolvedValue({ userId: "other-user", organizationId: "deleted-org", role: "admin" });
    expect(await getActiveTenant(new Headers())).toEqual({
      ok: false, error: "Organization access denied", status: 403,
    });
    expect(Sentry.setTag).not.toHaveBeenCalled();
  });
});
