import { describe, expect, it } from "vitest";
import { cellDirectory } from "./cells.js";

const cells = JSON.stringify([
  { id: "eu", label: "Europe", url: "https://superlog.sh" },
  { id: "us", label: "United States", url: "https://us.superlog.sh/" },
]);

describe("cell directory", () => {
  it("is absent when the deployment runs a single cell", () => {
    expect(cellDirectory({})).toBeNull();
  });

  it("lists the cells, the current cell, and the shared cookie domain", () => {
    expect(
      cellDirectory({
        RESPONDER_CELL_COOKIE_DOMAIN: ".superlog.sh",
        RESPONDER_CELL_ID: "us",
        RESPONDER_CELLS: cells,
      }),
    ).toEqual({
      cells: [
        { id: "eu", label: "Europe", url: "https://superlog.sh" },
        { id: "us", label: "United States", url: "https://us.superlog.sh" },
      ],
      cookieDomain: ".superlog.sh",
      current: "us",
    });
  });

  it("rejects a current cell that is not listed", () => {
    expect(() =>
      cellDirectory({ RESPONDER_CELL_ID: "ap", RESPONDER_CELLS: cells }),
    ).toThrow(/not one of RESPONDER_CELLS/);
  });

  it.each([
    ["a non-HTTPS address", "http://us.superlog.sh"],
    ["an address with a path", "https://us.superlog.sh/app"],
    ["an address with credentials", "https://user:pass@us.superlog.sh"],
  ])("rejects a cell at %s", (_, url) => {
    expect(() =>
      cellDirectory({
        RESPONDER_CELL_ID: "us",
        RESPONDER_CELLS: JSON.stringify([{ id: "us", label: "United States", url }]),
      }),
    ).toThrow(/must be an HTTPS origin/);
  });

  it("allows a local HTTP cell for development", () => {
    expect(
      cellDirectory({
        RESPONDER_CELL_ID: "local",
        RESPONDER_CELLS: JSON.stringify([
          { id: "local", label: "Local", url: "http://localhost:3000" },
        ]),
      })?.cells[0]?.url,
    ).toBe("http://localhost:3000");
  });

  it("rejects a cookie domain that does not cover every cell", () => {
    expect(() =>
      cellDirectory({
        RESPONDER_CELL_COOKIE_DOMAIN: ".example.com",
        RESPONDER_CELL_ID: "us",
        RESPONDER_CELLS: cells,
      }),
    ).toThrow(/does not cover/);
  });

  it("rejects malformed and duplicate cell identifiers", () => {
    expect(() =>
      cellDirectory({ RESPONDER_CELL_ID: "eu", RESPONDER_CELLS: "not json" }),
    ).toThrow(/RESPONDER_CELLS/);
    expect(() =>
      cellDirectory({
        RESPONDER_CELL_ID: "eu",
        RESPONDER_CELLS: JSON.stringify([
          { id: "eu", label: "Europe", url: "https://superlog.sh" },
          { id: "eu", label: "Europe", url: "https://eu.superlog.sh" },
        ]),
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      cellDirectory({
        RESPONDER_CELL_ID: "EU 1",
        RESPONDER_CELLS: JSON.stringify([
          { id: "EU 1", label: "Europe", url: "https://superlog.sh" },
        ]),
      }),
    ).toThrow(/identifier/);
  });
});
