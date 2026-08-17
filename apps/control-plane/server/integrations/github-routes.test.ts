import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disableAgentsWithUnavailableRepositories } from "../../../../packages/core/src/db/agents.js";
import {
  consumeIntegrationConnectionState,
  listOrganizationIntegrationAccounts,
  replaceRepositories,
  upsertIntegrationAccount,
} from "../../../../packages/core/src/db/integrations.js";
import { getActiveTenant } from "../tenant.js";
import {
  exchangeGitHubCode,
  listGitHubRepositories,
  verifyGitHubUserInstallation,
} from "./github.js";
import { integrationRoutes } from "./routes.js";

vi.mock("../../../../packages/core/src/db/agents.js", () => ({
  disableAgentsWithUnavailableRepositories: vi.fn(),
}));

vi.mock("../../../../packages/core/src/credentials/encryption.js", () => ({
  decryptCredentials: vi.fn(),
  encryptCredentials: vi.fn(),
}));

vi.mock("../../../../packages/core/src/db/integrations.js", () => ({
  consumeIntegrationConnectionState: vi.fn(),
  createIntegrationConnectionState: vi.fn(),
  getRecoverableSentryIntegrationAccount: vi.fn(),
  listOrganizationIntegrationAccounts: vi.fn(),
  replaceIntegrationResources: vi.fn(),
  replaceRepositories: vi.fn(),
  setIntegrationAccountStatus: vi.fn(),
  upsertIntegrationAccount: vi.fn(),
}));

vi.mock("../tenant.js", () => ({
  getActiveTenant: vi.fn(),
}));

vi.mock("./github.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github.js")>()),
  exchangeGitHubCode: vi.fn(),
  listGitHubRepositories: vi.fn(),
  listGitHubUserInstallations: vi.fn(),
  verifyGitHubUserInstallation: vi.fn(),
}));

const app = new Hono().route("/api/integrations", integrationRoutes);
const tenant = {
  ok: true as const,
  organizationId: "10000000-0000-4000-8000-000000000000",
  user: {
    id: "20000000-0000-4000-8000-000000000000",
    name: "Test User",
    email: "test@example.com",
  },
};

function configureGitHub() {
  vi.stubEnv("GITHUB_APP_ID", "123");
  vi.stubEnv("GITHUB_APP_SLUG", "responder-test");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "private-key");
  vi.stubEnv("GITHUB_CLIENT_ID", "github-client");
  vi.stubEnv("GITHUB_CLIENT_SECRET", "github-secret");
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "webhook-secret");
}

describe("GitHub integration routing", () => {
  beforeEach(() => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("offers App installation as the first connection flow", async () => {
    configureGitHub();
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(listOrganizationIntegrationAccounts).mockResolvedValue([]);

    const response = await app.request("/api/integrations");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.integrations).toContainEqual(
      expect.objectContaining({
        id: "github",
        connectUrl: "/api/integrations/github/start?mode=install",
        configurationUrl: "/api/integrations/github/start?mode=install",
      }),
    );
  });

  it("offers authorization when an installation already exists", async () => {
    configureGitHub();
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(listOrganizationIntegrationAccounts).mockResolvedValue([
      {
        id: "30000000-0000-4000-8000-000000000000",
        provider: "github",
        externalAccountId: "12345",
        displayName: "example",
        status: "connected",
        metadata: {},
        updatedAt: new Date("2026-08-02T17:00:00Z"),
        resourceCount: 2,
      },
    ]);

    const response = await app.request("/api/integrations");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.integrations).toContainEqual(
      expect.objectContaining({
        id: "github",
        connectUrl: "/api/integrations/github/start",
        configurationUrl: "/api/integrations/github/start?mode=install",
      }),
    );
  });

  it("reports agents paused after refreshed repository access is synchronized", async () => {
    configureGitHub();
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue({
      codeVerifier: null,
      metadata: {},
      organizationId: tenant.organizationId,
      returnTo: "/settings",
      userId: tenant.user.id,
    });
    vi.mocked(exchangeGitHubCode).mockResolvedValue({
      access_token: "user-token",
      token_type: "bearer",
    });
    vi.mocked(verifyGitHubUserInstallation).mockResolvedValue({
      account: { id: 98, login: "example", type: "Organization" },
      id: 12345,
      repository_selection: "selected",
    });
    vi.mocked(listGitHubRepositories).mockResolvedValue([
      {
        defaultBranch: "main",
        externalId: "987",
        fullName: "example/service",
        metadata: { owner: "example" },
        private: true,
      },
    ]);
    vi.mocked(upsertIntegrationAccount).mockResolvedValue(
      "30000000-0000-4000-8000-000000000000",
    );
    vi.mocked(disableAgentsWithUnavailableRepositories).mockResolvedValue([
      { id: "agent-1", name: "Production responder" },
      { id: "agent-2", name: "API responder" },
    ]);

    const response = await app.request(
      "/api/integrations/github/callback" +
        "?code=one-time-code" +
        "&installation_id=12345" +
        "&setup_action=install" +
        "&state=connection-state",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://responder.example/settings" +
        "?integration=github" +
        "&status=connected" +
        "&disabled_agents=2",
    );
    expect(replaceRepositories).toHaveBeenCalledWith(
      "30000000-0000-4000-8000-000000000000",
      expect.arrayContaining([
        expect.objectContaining({ fullName: "example/service" }),
      ]),
    );
    expect(disableAgentsWithUnavailableRepositories).toHaveBeenCalledWith(
      tenant.organizationId,
    );
  });
});
