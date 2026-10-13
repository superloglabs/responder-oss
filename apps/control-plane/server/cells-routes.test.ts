import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "./app.js";

describe("cell directory route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("tells a signed-out visitor which cells exist", async () => {
    vi.stubEnv(
      "RESPONDER_CELLS",
      JSON.stringify([
        { id: "eu", label: "Europe", url: "https://superlog.sh" },
        { id: "us", label: "United States", url: "https://us.superlog.sh" },
      ]),
    );
    vi.stubEnv("RESPONDER_CELL_ID", "eu");
    vi.stubEnv("RESPONDER_CELL_COOKIE_DOMAIN", ".superlog.sh");

    const response = await app.request("/api/cells");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cells: [
        { id: "eu", label: "Europe", url: "https://superlog.sh" },
        { id: "us", label: "United States", url: "https://us.superlog.sh" },
      ],
      cookieDomain: ".superlog.sh",
      current: "eu",
    });
  });

  it("returns no cells for a single-cell deployment", async () => {
    vi.stubEnv("RESPONDER_CELLS", "");

    const response = await app.request("/api/cells");

    await expect(response.json()).resolves.toEqual({
      cells: [],
      cookieDomain: null,
      current: null,
    });
  });
});

describe("cell OAuth callback routing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends a callback started on another cell back to that cell", async () => {
    vi.stubEnv(
      "RESPONDER_CELLS",
      JSON.stringify([
        { id: "eu", label: "Europe", url: "https://superlog.sh" },
        { id: "us", label: "United States", url: "https://us.superlog.sh" },
      ]),
    );
    vi.stubEnv("RESPONDER_CELL_ID", "eu");
    const state = `responder-v1.${Buffer.from("https://us.superlog.sh/api/integrations/slack/callback").toString("base64url")}.nonce`;

    const response = await app.request(
      `/api/integrations/slack/callback?code=abc&state=${state}`,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `https://us.superlog.sh/api/integrations/slack/callback?code=abc&state=${state}`,
    );
  });
});
