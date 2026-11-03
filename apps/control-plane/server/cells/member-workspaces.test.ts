import { afterEach, describe, expect, it, vi } from "vitest";
import type { CellDirectory } from "../../../../packages/core/src/cells.js";
import { askCellForMemberWorkspaces, workspacesInOtherCells } from "./member-workspaces.js";

const europe = { id: "eu", label: "Europe", url: "https://eu.example.com" };
const unitedStates = { id: "us", label: "United States", url: "https://us.example.com" };
const asia = { id: "ap", label: "Asia", url: "https://ap.example.com" };
const directory: CellDirectory = { cells: [europe, unitedStates, asia], cookieDomain: ".example.com", current: "eu" };

describe("workspaces in other cells", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks every other cell and names each workspace with its cell", async () => {
    const askCell = vi.fn(async (cell: { id: string }) =>
      cell.id === "us" ? [{ name: "Acme" }] : []);

    await expect(workspacesInOtherCells({ askCell, directory, email: "ash@example.com", token: "cell-token" }))
      .resolves.toEqual([{ cell: unitedStates, name: "Acme" }]);
    expect(askCell.mock.calls.map(([cell]) => cell.id)).toEqual(["us", "ap"]);
    expect(askCell).toHaveBeenCalledWith(unitedStates, "ash@example.com", "cell-token");
  });

  it("leaves out a cell that cannot answer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const askCell = vi.fn(async (cell: { id: string }) => {
      if (cell.id === "us") throw new Error("Cell us answered 503");
      return [{ name: "Beta" }];
    });

    await expect(workspacesInOtherCells({ askCell, directory, email: "ash@example.com", token: "cell-token" }))
      .resolves.toEqual([{ cell: asia, name: "Beta" }]);
  });

  it("asks no cell in a single-cell deployment or without the cell token", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const askCell = vi.fn();

    await expect(workspacesInOtherCells({ askCell, directory: null, email: "ash@example.com", token: "cell-token" }))
      .resolves.toEqual([]);
    await expect(workspacesInOtherCells({ askCell, directory, email: "ash@example.com", token: undefined }))
      .resolves.toEqual([]);
    expect(askCell).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(JSON.stringify({ event: "member_workspaces_cell_token_missing" }));
  });

  it("fails on an error answer and when the cell does not answer in time", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockImplementationOnce(async (_url, init) => {
        const signal = (init as RequestInit).signal!;
        expect(signal).toBeInstanceOf(AbortSignal);
        throw new DOMException("The operation timed out.", "TimeoutError");
      });

    await expect(askCellForMemberWorkspaces(unitedStates, "ash@example.com", "cell-token"))
      .rejects.toThrow("Cell us answered 503");
    await expect(askCellForMemberWorkspaces(unitedStates, "ash@example.com", "cell-token"))
      .rejects.toThrow("timed out");
  });

  it("sends the cell token and rejects an answer without a workspace list", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ workspaces: [{ name: "Acme" }] }))
      .mockResolvedValueOnce(Response.json({ users: [] }));

    await expect(askCellForMemberWorkspaces(unitedStates, "ash@example.com", "cell-token"))
      .resolves.toEqual([{ name: "Acme" }]);
    expect(fetch).toHaveBeenCalledWith(
      new URL("/api/internal/cells/member-workspaces", unitedStates.url),
      expect.objectContaining({
        body: JSON.stringify({ email: "ash@example.com" }),
        headers: { authorization: "Bearer cell-token", "content-type": "application/json" },
        method: "POST",
      }),
    );
    await expect(askCellForMemberWorkspaces(unitedStates, "ash@example.com", "cell-token"))
      .rejects.toThrow("Cell us sent no workspaces");
  });
});
