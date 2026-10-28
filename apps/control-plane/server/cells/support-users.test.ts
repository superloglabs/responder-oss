import { afterEach, describe, expect, it, vi } from "vitest";

const { listSupportUsers } = vi.hoisted(() => ({ listSupportUsers: vi.fn() }));
vi.mock("../../../../packages/core/src/db/superusers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../packages/core/src/db/superusers.js")>()),
  listSupportUsers,
}));

import { app } from "../app.js";
import { type SupportUser, supportUsersAcrossCells } from "./support-users.js";

const eu = { id: "eu", label: "Europe", url: "https://superlog.sh" };
const us = { id: "us", label: "United States", url: "https://us.superlog.sh" };
const directory = { cells: [eu, us], cookieDomain: "superlog.sh", current: "eu" };

function user(id: string, createdAt: string): SupportUser {
  return {
    banned: false,
    canImpersonate: true,
    createdAt,
    email: `${id}@example.com`,
    id,
    image: null,
    name: id,
    role: "user",
  };
}

describe("support users across cells", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("lists only this cell's users when there is one cell", async () => {
    const result = await supportUsersAcrossCells({
      directory: null,
      local: [user("ana", "2026-10-01T00:00:00.000Z")],
      search: undefined,
      token: undefined,
    });

    expect(result).toEqual({
      currentCell: null,
      unavailableCells: [],
      users: [{ ...user("ana", "2026-10-01T00:00:00.000Z"), cell: null }],
    });
  });

  it("merges every cell's users, newest first, and names each user's cell", async () => {
    const askCell = vi.fn().mockResolvedValue([user("ali", "2026-10-26T00:00:00.000Z")]);

    const result = await supportUsersAcrossCells({
      askCell,
      directory,
      local: [user("ana", "2026-10-01T00:00:00.000Z")],
      search: "a",
      token: "cell-token",
    });

    expect(askCell).toHaveBeenCalledWith(us, "a", "cell-token");
    expect(result.currentCell).toBe("eu");
    expect(result.unavailableCells).toEqual([]);
    expect(result.users.map((listed) => [listed.id, listed.cell?.id])).toEqual([
      ["ali", "us"],
      ["ana", "eu"],
    ]);
  });

  it("keeps this cell's users when another cell does not answer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const askCell = vi.fn().mockRejectedValue(new Error("Cell us answered 502"));

    const result = await supportUsersAcrossCells({
      askCell,
      directory,
      local: [user("ana", "2026-10-01T00:00:00.000Z")],
      search: undefined,
      token: "cell-token",
    });

    expect(result.unavailableCells).toEqual([us]);
    expect(result.users.map((listed) => listed.id)).toEqual(["ana"]);
  });

  it("asks no other cell without the cell token", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const askCell = vi.fn();

    const result = await supportUsersAcrossCells({
      askCell,
      directory,
      local: [],
      search: undefined,
      token: undefined,
    });

    expect(askCell).not.toHaveBeenCalled();
    expect(result.unavailableCells).toEqual([us]);
  });
});

describe("support users route for other cells", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  const ask = (body: unknown, token?: string) =>
    app.request("/api/internal/cells/support-users", {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      method: "POST",
    });

  it("lists this cell's users and whether each may be impersonated", async () => {
    vi.stubEnv("RESPONDER_CELL_TOKEN", "cell-token");
    vi.stubEnv("SUPERUSER_EMAILS", "admin@example.com");
    listSupportUsers.mockResolvedValue([
      { ...user("ali", ""), createdAt: new Date("2026-10-26T00:00:00.000Z") },
      {
        ...user("admin", ""),
        createdAt: new Date("2026-10-02T00:00:00.000Z"),
        email: "admin@example.com",
      },
    ]);

    const response = await ask({ search: " nautilus " }, "cell-token");

    expect(listSupportUsers).toHaveBeenCalledWith("nautilus");
    const body = (await response.json()) as { users: SupportUser[] };
    expect(body.users.map((listed) => [listed.id, listed.canImpersonate, listed.createdAt])).toEqual([
      ["ali", true, "2026-10-26T00:00:00.000Z"],
      ["admin", false, "2026-10-02T00:00:00.000Z"],
    ]);
  });

  it("rejects callers without the cell token, and every caller when none is configured", async () => {
    vi.stubEnv("RESPONDER_CELL_TOKEN", "cell-token");
    expect((await ask({}, "wrong")).status).toBe(401);
    vi.stubEnv("RESPONDER_CELL_TOKEN", "");
    expect((await ask({}, "")).status).toBe(401);
    expect(listSupportUsers).not.toHaveBeenCalled();
  });

  it("rejects an invalid search", async () => {
    vi.stubEnv("RESPONDER_CELL_TOKEN", "cell-token");
    expect((await ask({ search: "x".repeat(321) }, "cell-token")).status).toBe(400);
  });
});
