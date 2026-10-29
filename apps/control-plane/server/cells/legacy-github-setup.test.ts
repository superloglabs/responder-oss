import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CellDirectory } from "../../../../packages/core/src/cells.js";
import {
  type LegacyGitHubSetupDependencies,
  legacyGitHubSetupRedirect,
  legacyGitHubSetupUrl,
} from "./legacy-github-setup.js";

const directory: CellDirectory = {
  cells: [
    { id: "eu", label: "Europe", url: "https://superlog.sh" },
    { id: "us", label: "United States", url: "https://us.superlog.sh" },
  ],
  cookieDomain: ".superlog.sh",
  current: "eu",
};

const legacySetupUrl = "https://api.superlog.sh/github/install/callback";
const callbackPath = "/api/integrations/github/callback";

function harness(overrides: Partial<LegacyGitHubSetupDependencies> = {}) {
  const handled = vi.fn();
  const dependencies: LegacyGitHubSetupDependencies = {
    askCell: vi.fn(async () => ({ active: false, held: false })),
    cellToken: () => "cell-token",
    directory: () => directory,
    hasPendingFlow: vi.fn(async () => false),
    setupUrl: () => legacySetupUrl,
    tenantState: vi.fn(async () => ({ active: false, held: false })),
    ...overrides,
  };
  const app = new Hono()
    .use(callbackPath, legacyGitHubSetupRedirect(dependencies))
    .get(callbackPath, (context) => {
      handled(context.req.url);
      return context.json({ from: "application" });
    });
  return { app, dependencies, handled };
}

const applicationState = `responder-v1.${Buffer.from(`https://superlog.sh${callbackPath}`).toString("base64url")}.nonce`;
// The old product signs base64url(kind.value.timestamp) with an HMAC.
const oldProductState = `${Buffer.from("web.eyJwcm9qZWN0SWQiOiJwIn0.1761730000000").toString("base64url")}.c2lnbmF0dXJl`;

describe("legacy GitHub setup redirect", () => {
  it("continues a callback whose state the application created", async () => {
    const { app, dependencies, handled } = harness();

    const response = await app.request(
      `${callbackPath}?installation_id=42&setup_action=install&state=${encodeURIComponent(applicationState)}`,
    );

    expect(await response.json()).toEqual({ from: "application" });
    expect(handled).toHaveBeenCalledOnce();
    expect(dependencies.hasPendingFlow).not.toHaveBeenCalled();
  });

  it("redirects a callback with another state to the old product with its query unchanged", async () => {
    const { app, handled } = harness();
    const query = `?installation_id=42&setup_action=install&state=${encodeURIComponent(oldProductState)}&code=abc`;

    const response = await app.request(`${callbackPath}${query}`);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${legacySetupUrl}${query}`);
    expect(handled).not.toHaveBeenCalled();
  });

  it("keeps a callback without state when the signed-in user has a GitHub connection pending", async () => {
    const { app, dependencies, handled } = harness({ hasPendingFlow: vi.fn(async () => true) });

    const response = await app.request(`${callbackPath}?installation_id=42&setup_action=update`);

    expect(await response.json()).toEqual({ from: "application" });
    expect(handled).toHaveBeenCalledOnce();
    expect(dependencies.tenantState).not.toHaveBeenCalled();
  });

  it("keeps a callback without state for an installation an active workspace here holds", async () => {
    const { app, dependencies, handled } = harness({
      tenantState: vi.fn(async () => ({ active: true, held: true })),
    });

    await app.request(`${callbackPath}?installation_id=42&setup_action=update`);

    expect(handled).toHaveBeenCalledOnce();
    expect(dependencies.tenantState).toHaveBeenCalledWith({ key: "42", provider: "github" });
  });

  it("sends a callback without state to the cell whose active workspace holds the installation", async () => {
    const { app, handled } = harness({
      askCell: vi.fn(async () => ({ active: true, held: true })),
    });
    const query = "?installation_id=42&setup_action=update";

    const response = await app.request(`${callbackPath}${query}`);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`https://us.superlog.sh${callbackPath}${query}`);
    expect(handled).not.toHaveBeenCalled();
  });

  it("redirects a callback without state to the old product when only paused workspaces hold the installation", async () => {
    const { app, handled } = harness({
      askCell: vi.fn(async () => ({ active: false, held: true })),
      tenantState: vi.fn(async () => ({ active: false, held: true })),
    });
    const query = "?installation_id=42&setup_action=update";

    const response = await app.request(`${callbackPath}${query}`);

    expect(response.headers.get("location")).toBe(`${legacySetupUrl}${query}`);
    expect(handled).not.toHaveBeenCalled();
  });

  it("keeps a callback without state when a cell that might hold the installation cannot be asked", async () => {
    const { app, handled } = harness({
      askCell: vi.fn(async () => {
        throw new Error("cell unavailable");
      }),
    });

    const response = await app.request(`${callbackPath}?installation_id=42&setup_action=update`);

    expect(await response.json()).toEqual({ from: "application" });
    expect(handled).toHaveBeenCalledOnce();
  });

  it("keeps a callback without state when other cells exist but there is no cell token to ask them", async () => {
    const { app, dependencies, handled } = harness({ cellToken: () => undefined });

    const response = await app.request(`${callbackPath}?installation_id=42&setup_action=update`);

    expect(await response.json()).toEqual({ from: "application" });
    expect(handled).toHaveBeenCalledOnce();
    expect(dependencies.askCell).not.toHaveBeenCalled();
  });

  it("lets the application answer when it cannot tell whose callback it is", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app, handled } = harness({
      tenantState: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    });

    await app.request(`${callbackPath}?installation_id=42&setup_action=update`);

    expect(handled).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("does nothing without a configured address, and rejects one that is not HTTPS", async () => {
    const { app, handled } = harness({ setupUrl: () => null });
    await app.request(`${callbackPath}?installation_id=42&state=${encodeURIComponent(oldProductState)}`);
    expect(handled).toHaveBeenCalledOnce();

    expect(legacyGitHubSetupUrl({})).toBeNull();
    expect(legacyGitHubSetupUrl({ LEGACY_GITHUB_SETUP_URL: legacySetupUrl })).toBe(legacySetupUrl);
    expect(() => legacyGitHubSetupUrl({ LEGACY_GITHUB_SETUP_URL: "http://api.superlog.sh/x" }))
      .toThrow(/LEGACY_GITHUB_SETUP_URL/u);
  });
});
