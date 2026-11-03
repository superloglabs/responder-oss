import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  listWorkspaces: vi.fn(),
  otherCells: vi.fn(),
}));

vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  getAuth: () => ({ api: { getSession: mocks.getSession } }),
}));

vi.mock("../../../packages/core/src/db/member-workspaces.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../packages/core/src/db/member-workspaces.js")>()),
  listVerifiedMemberWorkspaces: mocks.listWorkspaces,
}));

vi.mock("./cells/member-workspaces.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cells/member-workspaces.js")>()),
  workspacesInOtherCells: mocks.otherCells,
}));

import { app } from "./app.js";

const cells = JSON.stringify([
  { id: "eu", label: "Europe", url: "https://eu.example.com" },
  { id: "us", label: "United States", url: "https://us.example.com" },
]);

describe("member workspace routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RESPONDER_CELLS", cells);
    vi.stubEnv("RESPONDER_CELL_ID", "eu");
    vi.stubEnv("RESPONDER_CELL_COOKIE_DOMAIN", ".example.com");
    vi.stubEnv("RESPONDER_CELL_TOKEN", "cell-token");
    mocks.getSession.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("names this cell's workspaces for an address to another cell", async () => {
    mocks.listWorkspaces.mockResolvedValue([{ name: "Acme", slug: "acme" }]);

    const response = await app.request("/api/internal/cells/member-workspaces", {
      body: JSON.stringify({ email: "ash@example.com" }),
      headers: { authorization: "Bearer cell-token", "content-type": "application/json" },
      method: "POST",
    });

    await expect(response.json()).resolves.toEqual({ workspaces: [{ name: "Acme", slug: "acme" }] });
    expect(mocks.listWorkspaces).toHaveBeenCalledWith("ash@example.com");
  });

  it("requires a session", async () => {
    const response = await app.request("/api/cells/workspaces");

    expect(response.status).toBe(401);
    expect(mocks.otherCells).not.toHaveBeenCalled();
  });

  it("asks the other cells for a verified session's address", async () => {
    mocks.getSession.mockResolvedValue({
      session: {},
      user: { email: "ash@example.com", emailVerified: true, id: "user-verified" },
    });
    const unitedStates = { id: "us", label: "United States", url: "https://us.example.com" };
    mocks.otherCells.mockResolvedValue([{ cell: unitedStates, name: "Acme", slug: "acme" }]);

    const response = await app.request("/api/cells/workspaces");

    await expect(response.json()).resolves.toEqual({
      cookieDomain: ".example.com",
      workspaces: [{ cell: unitedStates, name: "Acme", slug: "acme" }],
    });
    expect(mocks.otherCells).toHaveBeenCalledWith(expect.objectContaining({
      email: "ash@example.com",
      token: "cell-token",
    }));
  });

  it("names nothing to an unverified account or an impersonating superuser", async () => {
    for (const session of [
      { session: {}, user: { email: "ash@example.com", emailVerified: false, id: "user-unverified" } },
      { session: { impersonatedBy: "admin" }, user: { email: "ash@example.com", emailVerified: true, id: "user-impersonated" } },
    ]) {
      mocks.getSession.mockResolvedValue(session);

      const response = await app.request("/api/cells/workspaces");

      await expect(response.json()).resolves.toEqual({ cookieDomain: ".example.com", workspaces: [] });
    }
    expect(mocks.otherCells).not.toHaveBeenCalled();
  });

  it("limits how often one person looks", async () => {
    mocks.getSession.mockResolvedValue({
      session: {},
      user: { email: "ash@example.com", emailVerified: true, id: "user-limited" },
    });
    mocks.otherCells.mockResolvedValue([]);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      statuses.push((await app.request("/api/cells/workspaces")).status);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 429]);
  });
});
