import { describe, expect, it } from "vitest";
import { cellCookie, cellSwitchUrl } from "./cells";

describe("cell cookie", () => {
  it("remembers the cell on the shared parent domain for a year", () => {
    expect(cellCookie("us", ".superlog.sh", true)).toBe(
      "responder_cell=us; Max-Age=31536000; Path=/; SameSite=Lax; Domain=.superlog.sh; Secure",
    );
  });

  it("stays on the current host without a shared domain", () => {
    expect(cellCookie("local", null, false)).toBe(
      "responder_cell=local; Max-Age=31536000; Path=/; SameSite=Lax",
    );
  });
});

describe("cell switch URL", () => {
  it("keeps the path and query on the other cell", () => {
    expect(
      cellSwitchUrl(
        { id: "us", label: "United States", url: "https://us.superlog.sh" },
        new URL("https://superlog.sh/automations/new?signup=1&template=triage"),
      ),
    ).toBe("https://us.superlog.sh/automations/new?signup=1&template=triage");
  });

  it("drops a failed sign-in's error from the address", () => {
    expect(
      cellSwitchUrl(
        { id: "eu", label: "Europe", url: "https://superlog.sh" },
        new URL("https://us.superlog.sh/app?signup=1&error=access_denied&error_description=x"),
      ),
    ).toBe("https://superlog.sh/app?signup=1");
  });
});
