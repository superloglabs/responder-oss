import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CellDirectory } from "../../../../packages/core/src/cells.js";
import {
  getPendingIntegrationConnectionState,
  listConnectedIntegrationAccounts,
} from "../../../../packages/core/src/db/integrations.js";
import { getActiveTenant } from "../tenant.js";
import {
  keepsGitHubSetupHere,
  type LegacyGitHubSetupDependencies,
  legacyGitHubSetupRedirect,
  legacyGitHubSetupUrl,
} from "./legacy-github-setup.js";

vi.mock("../../../../packages/core/src/db/integrations.js", () => ({
  getPendingIntegrationConnectionState: vi.fn(),
  listConnectedIntegrationAccounts: vi.fn(),
}));

vi.mock("../tenant.js", () => ({
  getActiveTenant: vi.fn(),
}));

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
    directory: () => directory,
    keepsHere: vi.fn(async () => false),
    setupUrl: () => legacySetupUrl,
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
    expect(dependencies.keepsHere).not.toHaveBeenCalled();
  });

  it("redirects a callback with another state to the old product with its query unchanged", async () => {
    const { app, handled } = harness();
    const query = `?installation_id=42&setup_action=install&state=${encodeURIComponent(oldProductState)}&code=abc`;

    const response = await app.request(`${callbackPath}${query}`);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${legacySetupUrl}${query}`);
    expect(handled).not.toHaveBeenCalled();
  });

  it("keeps a callback without state when the signed-in user's workspace holds the installation or a GitHub connection is pending", async () => {
    const { app, dependencies, handled } = harness({ keepsHere: vi.fn(async () => true) });

    const response = await app.request(`${callbackPath}?installation_id=42&setup_action=update`);

    expect(await response.json()).toEqual({ from: "application" });
    expect(handled).toHaveBeenCalledOnce();
    expect(dependencies.keepsHere).toHaveBeenCalledWith(expect.any(Headers), 42);
  });

  it("sends a callback without state to the other cell the browser last used", async () => {
    const { app, handled } = harness();
    const query = "?installation_id=42&setup_action=update";

    const response = await app.request(`${callbackPath}${query}`, {
      headers: { cookie: "responder_cell=us" },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`https://us.superlog.sh${callbackPath}${query}`);
    expect(handled).not.toHaveBeenCalled();
  });

  it("redirects a callback without state to the old product when the browser last used this cell or none", async () => {
    const query = "?installation_id=42&setup_action=update";
    for (const headers of [{ cookie: "responder_cell=eu" }, { cookie: "responder_cell=elsewhere" }, {}] as Array<Record<string, string>>) {
      const { app, handled } = harness();

      const response = await app.request(`${callbackPath}${query}`, { headers });

      expect(response.headers.get("location")).toBe(`${legacySetupUrl}${query}`);
      expect(handled).not.toHaveBeenCalled();
    }
  });

  it("answers a signed-out callback without state the same way for any installation", async () => {
    const locations = new Set<string | null>();
    for (const installationId of [1, 42, 99_999_999]) {
      const { app } = harness();
      const response = await app.request(`${callbackPath}?setup_action=update`);
      const withInstallation = await app.request(
        `${callbackPath}?installation_id=${installationId}&setup_action=update`,
      );
      locations.add(new URL(response.headers.get("location")!).origin);
      locations.add(new URL(withInstallation.headers.get("location")!).origin);
    }

    expect([...locations]).toEqual([new URL(legacySetupUrl).origin]);
  });

  it("lets the application answer when it cannot tell whose callback it is", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app, handled } = harness({
      keepsHere: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    });

    await app.request(`${callbackPath}?installation_id=42&setup_action=update`);

    expect(handled).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("lets the application answer when the cell directory is misconfigured", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app, handled } = harness({
      directory: () => {
        throw new Error("CELL_DIRECTORY is invalid");
      },
    });

    const response = await app.request(`${callbackPath}?installation_id=42&setup_action=update`, {
      headers: { cookie: "responder_cell=us" },
    });

    expect(response.status).toBe(200);
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

describe("keepsGitHubSetupHere", () => {
  const headers = new Headers();
  const tenant = {
    ok: true as const,
    organizationId: "10000000-0000-4000-8000-000000000000",
    role: "member",
    user: { email: "test@example.com", id: "20000000-0000-4000-8000-000000000000", name: "Test User" },
  };

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("does not look up the installation for a signed-out browser", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue({ error: "Unauthorized", ok: false, status: 401 });

    await expect(keepsGitHubSetupHere(headers, 42)).resolves.toBe(false);
    expect(listConnectedIntegrationAccounts).not.toHaveBeenCalled();
  });

  it("keeps a pending GitHub connection", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(getPendingIntegrationConnectionState).mockResolvedValue({ metadata: {}, returnTo: "/settings" });

    await expect(keepsGitHubSetupHere(headers, null)).resolves.toBe(true);
  });

  it("keeps an installation only the signed-in user's workspace holds", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(getPendingIntegrationConnectionState).mockResolvedValue(null);
    vi.mocked(listConnectedIntegrationAccounts).mockResolvedValue([
      { externalAccountId: "42", id: "30000000-0000-4000-8000-000000000000" },
    ]);

    await expect(keepsGitHubSetupHere(headers, 42)).resolves.toBe(true);
    await expect(keepsGitHubSetupHere(headers, 43)).resolves.toBe(false);
    expect(listConnectedIntegrationAccounts).toHaveBeenCalledWith(tenant.organizationId, "github");
  });
});
