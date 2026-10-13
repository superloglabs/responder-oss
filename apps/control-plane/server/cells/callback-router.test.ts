import { describe, expect, it } from "vitest";
import type { CellDirectory } from "../../../../packages/core/src/cells.js";
import { cellCallbackRedirect } from "./callback-router.js";

const directory: CellDirectory = {
  cells: [
    { id: "eu", label: "Europe", url: "https://superlog.sh" },
    { id: "us", label: "United States", url: "https://us.superlog.sh" },
  ],
  cookieDomain: ".superlog.sh",
  current: "eu",
};

const state = (routingUrl: string) =>
  `responder-v1.${Buffer.from(routingUrl).toString("base64url")}.nonce`;

const callback = (stateValue: string, path = "/api/integrations/slack/callback") =>
  new URL(`https://superlog.sh${path}?code=abc&state=${encodeURIComponent(stateValue)}`);

describe("cell callback routing", () => {
  it("sends a callback to the cell that started the flow", () => {
    const request = callback(state("https://us.superlog.sh/api/integrations/slack/callback"));

    expect(cellCallbackRedirect(request, directory)).toBe(
      `https://us.superlog.sh/api/integrations/slack/callback${request.search}`,
    );
  });

  it("keeps the request's own callback path rather than the path in the state", () => {
    const request = callback(state("https://us.superlog.sh/elsewhere"), "/api/integrations/github/callback");

    expect(cellCallbackRedirect(request, directory)).toBe(
      `https://us.superlog.sh/api/integrations/github/callback${request.search}`,
    );
  });

  it("handles callbacks for this cell, unknown origins, and plain states itself", () => {
    for (const request of [
      callback(state("https://superlog.sh/api/integrations/slack/callback")),
      callback(state("https://evil.example/api/integrations/slack/callback")),
      callback(state("not a url")),
      callback("plain-nonce"),
      new URL("https://superlog.sh/api/integrations/slack/callback?code=abc"),
    ]) {
      expect(cellCallbackRedirect(request, directory)).toBeNull();
    }
  });

  it("does nothing in a single-cell deployment", () => {
    expect(
      cellCallbackRedirect(callback(state("https://us.superlog.sh/api/integrations/slack/callback")), null),
    ).toBeNull();
  });
});
