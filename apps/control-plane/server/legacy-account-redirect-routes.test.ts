import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clear: vi.fn(),
  getSession: vi.fn(),
  shouldRedirect: vi.fn(),
}));

vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  getAuth: () => ({ api: { getSession: mocks.getSession } }),
}));

vi.mock("../../../packages/core/src/db/legacy-account-redirect.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../packages/core/src/db/legacy-account-redirect.js")>()),
  clearLegacyAccountRedirect: mocks.clear,
  shouldRedirectLegacyAccount: mocks.shouldRedirect,
}));

import { app } from "./app.js";

describe("legacy account redirect routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue(null);
  });

  it("requires a Responder session for the lookup", async () => {
    const response = await app.request("/api/legacy-account-redirect");

    expect(response.status).toBe(401);
    expect(mocks.shouldRedirect).not.toHaveBeenCalled();
  });

  it("returns the fixed legacy target for a marked session", async () => {
    mocks.getSession.mockResolvedValue({
      user: { email: "legacy@example.com", emailVerified: true },
    });
    mocks.shouldRedirect.mockResolvedValue(true);

    const response = await app.request("/api/legacy-account-redirect");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      redirect: true,
      targetUrl: "https://telemetry.superlog.sh/",
    });
    expect(mocks.shouldRedirect).toHaveBeenCalledWith("legacy@example.com");
  });

  it("clears a marker only for the authenticated user's email", async () => {
    mocks.getSession.mockResolvedValue({
      user: { email: "legacy@example.com", emailVerified: true },
    });

    const response = await app.request("/api/legacy-account-redirect/clear", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ redirect: false });
    expect(mocks.clear).toHaveBeenCalledWith("legacy@example.com");
  });

  it("neither reveals nor clears the routing of an unverified email", async () => {
    mocks.getSession.mockResolvedValue({
      user: { email: "legacy@example.com", emailVerified: false },
    });
    mocks.shouldRedirect.mockResolvedValue(true);

    const lookup = await app.request("/api/legacy-account-redirect");
    const clear = await app.request("/api/legacy-account-redirect/clear", {
      method: "POST",
    });

    await expect(lookup.json()).resolves.toEqual({ redirect: false });
    await expect(clear.json()).resolves.toEqual({ redirect: false });
    expect(mocks.shouldRedirect).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
  });
});
