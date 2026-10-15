import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disableAgentsWithUnavailableRepositories } from "../../../../packages/core/src/db/agents.js";
import {
  consumeIntegrationConnectionState,
  createIntegrationConnectionState,
  listConnectedIntegrationAccounts,
  listOrganizationIntegrationAccounts,
  replaceGitHubInstallationAccount,
  replaceRepositories,
  upsertGitHubInstallationAccount,
} from "../../../../packages/core/src/db/integrations.js";
import {
  getGitHubPullRequestAuthor,
  removeGitHubPullRequestAuthor,
  setGitHubPullRequestAuthor,
} from "../../../../packages/core/src/db/github-pull-request-authors.js";
import { getGitHubUser } from "../../../../packages/core/src/integrations/github-user-tokens.js";
import { getActiveTenant } from "../tenant.js";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import {
  exchangeGitHubCode,
  listGitHubRepositories,
  listGitHubUserInstallations,
  verifyGitHubUserInstallation,
} from "./github.js";
import { GitHubInstallationNotFoundError } from "../../../../packages/core/src/integrations/github.js";
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
  listConnectedIntegrationAccounts: vi.fn(),
  listOrganizationIntegrationAccounts: vi.fn(),
  replaceGitHubInstallationAccount: vi.fn(),
  replaceIntegrationResources: vi.fn(),
  replaceRepositories: vi.fn(),
  setIntegrationAccountStatus: vi.fn(),
  upsertGitHubInstallationAccount: vi.fn(),
  upsertIntegrationAccount: vi.fn(),
}));

vi.mock("../../../../packages/core/src/db/github-pull-request-authors.js", () => ({
  getGitHubPullRequestAuthor: vi.fn(),
  removeGitHubPullRequestAuthor: vi.fn(),
  setGitHubPullRequestAuthor: vi.fn(),
}));

vi.mock("../../../../packages/core/src/integrations/github-user-tokens.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../packages/core/src/integrations/github-user-tokens.js")>()),
  getGitHubUser: vi.fn(),
}));

vi.mock("../tenant.js", () => ({
  getActiveTenant: vi.fn(),
}));

vi.mock("../../../../packages/core/src/db/organization-capabilities.js", () => ({
  organizationHasCapability: vi.fn(),
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
  role: "member",
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
    vi.mocked(organizationHasCapability).mockResolvedValue(true);
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

  it.each(["install", "update"] as const)(
    "continues a code-less GitHub %s callback through explicit authorization",
    async (setupAction) => {
      configureGitHub();
      vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
      vi.mocked(consumeIntegrationConnectionState).mockResolvedValue({
        codeVerifier: null,
        metadata: {},
        organizationId: tenant.organizationId,
        returnTo: "/settings",
        userId: tenant.user.id,
      });
      vi.mocked(createIntegrationConnectionState).mockResolvedValue(
        "authorization-state",
      );

      const response = await app.request(
        "/api/integrations/github/callback" +
          "?installation_id=12345" +
          `&setup_action=${setupAction}` +
          "&state=installation-state",
      );

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!);
      expect(location.origin + location.pathname).toBe(
        "https://github.com/login/oauth/authorize",
      );
      expect(location.searchParams.get("client_id")).toBe("github-client");
      expect(location.searchParams.get("state")).toBe("authorization-state");
      expect(location.searchParams.get("redirect_uri")).toBe(
        "https://responder.example/api/integrations/github/callback",
      );
      expect(createIntegrationConnectionState).toHaveBeenCalledWith({
        metadata: { installationId: 12345 },
        organizationId: tenant.organizationId,
        provider: "github",
        returnTo: "/settings",
        routingUrl: "https://responder.example/api/integrations/github/callback",
        userId: tenant.user.id,
      });
      expect(exchangeGitHubCode).not.toHaveBeenCalled();
    },
  );

  it("uses the preserved installation after explicit authorization", async () => {
    configureGitHub();
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue({
      codeVerifier: null,
      metadata: { installationId: 12345 },
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
    vi.mocked(listGitHubRepositories).mockResolvedValue([]);
    vi.mocked(upsertGitHubInstallationAccount).mockResolvedValue({
      id: "30000000-0000-4000-8000-000000000000",
      replacedAccountIds: [],
    });
    vi.mocked(disableAgentsWithUnavailableRepositories).mockResolvedValue([]);

    const response = await app.request(
      "/api/integrations/github/callback" +
        "?code=one-time-code" +
        "&installation_id=67890" +
        "&state=authorization-state",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://responder.example/settings" +
        "?integration=github" +
        "&status=connected",
    );
    expect(exchangeGitHubCode).toHaveBeenCalledWith(
      "one-time-code",
      "https://responder.example/api/integrations/github/callback",
    );
    expect(verifyGitHubUserInstallation).toHaveBeenCalledWith(
      "user-token",
      12345,
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
    vi.mocked(upsertGitHubInstallationAccount).mockResolvedValue({
      id: "30000000-0000-4000-8000-000000000000",
      replacedAccountIds: [],
    });
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

  it("keeps one connection when the GitHub App is installed again", async () => {
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
      id: 12346,
      repository_selection: "selected",
    });
    vi.mocked(listGitHubRepositories).mockResolvedValue([]);
    vi.mocked(upsertGitHubInstallationAccount).mockResolvedValue({
      id: "30000000-0000-4000-8000-000000000000",
      replacedAccountIds: ["30000000-0000-4000-8000-000000000001"],
    });
    vi.mocked(disableAgentsWithUnavailableRepositories).mockResolvedValue([]);

    const response = await app.request(
      "/api/integrations/github/callback" +
        "?code=one-time-code" +
        "&installation_id=12346" +
        "&setup_action=install" +
        "&state=connection-state",
    );

    expect(response.status).toBe(302);
    expect(upsertGitHubInstallationAccount).toHaveBeenCalledWith({
      displayName: "example",
      installationId: 12346,
      metadata: {
        accountId: 98,
        accountType: "Organization",
        repositorySelection: "selected",
      },
      organizationId: tenant.organizationId,
    });
    expect(replaceGitHubInstallationAccount).toHaveBeenCalledWith({
      accountId: "30000000-0000-4000-8000-000000000000",
      replacedAccountId: "30000000-0000-4000-8000-000000000001",
    });
  });

  it("leaves connections unchanged when the installation disappears mid-connection", async () => {
    configureGitHub();
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
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
      id: 12346,
      repository_selection: "selected",
    });
    vi.mocked(listGitHubRepositories).mockRejectedValue(
      new GitHubInstallationNotFoundError(12346),
    );

    const response = await app.request(
      "/api/integrations/github/callback" +
        "?code=one-time-code" +
        "&installation_id=12346" +
        "&setup_action=install" +
        "&state=connection-state",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("status=error");
    expect(upsertGitHubInstallationAccount).not.toHaveBeenCalled();
    expect(replaceRepositories).not.toHaveBeenCalled();
  });

});

describe("GitHub pull request author", () => {
  const authorState = {
    codeVerifier: null,
    metadata: { purpose: "pull_request_author" },
    organizationId: tenant.organizationId,
    returnTo: "/settings/workspace",
    userId: tenant.user.id,
  };

  beforeEach(() => {
    configureGitHub();
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("asks the member to authorize the GitHub App", async () => {
    vi.mocked(createIntegrationConnectionState).mockResolvedValue("author-state");

    const response = await app.request("/api/integrations/github/pull-request-author/start");

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("state")).toBe("author-state");
    expect(createIntegrationConnectionState).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { purpose: "pull_request_author" },
      provider: "github",
      returnTo: "/settings/workspace",
      userId: tenant.user.id,
    }));
  });

  it("saves the member's token when their account reaches the workspace's installation", async () => {
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue(authorState);
    vi.mocked(exchangeGitHubCode).mockResolvedValue({
      access_token: "ghu_member",
      expires_in: 28_800,
      refresh_token: "ghr_member",
      refresh_token_expires_in: 15_811_200,
      token_type: "bearer",
    });
    vi.mocked(getGitHubUser).mockResolvedValue({ id: 583231, login: "octocat" });
    vi.mocked(listGitHubUserInstallations).mockResolvedValue([
      { account: { id: 98, login: "example", type: "Organization" }, id: 12345, repository_selection: "all" },
    ]);
    vi.mocked(listConnectedIntegrationAccounts).mockResolvedValue([
      { externalAccountId: "12345", id: "30000000-0000-4000-8000-000000000000" },
    ]);

    const response = await app.request(
      "/api/integrations/github/callback?code=one-time-code&state=author-state",
    );

    expect(response.headers.get("location")).toBe(
      "https://responder.example/settings/workspace?integration=github&status=connected",
    );
    expect(setGitHubPullRequestAuthor).toHaveBeenCalledWith({
      credentials: expect.objectContaining({ accessToken: "ghu_member", refreshToken: "ghr_member" }),
      githubLogin: "octocat",
      githubUserId: 583231,
      organizationId: tenant.organizationId,
      userId: tenant.user.id,
    });
    expect(upsertGitHubInstallationAccount).not.toHaveBeenCalled();
  });

  it("refuses an account that cannot reach the workspace's installation", async () => {
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue(authorState);
    vi.mocked(exchangeGitHubCode).mockResolvedValue({ access_token: "ghu_member", token_type: "bearer" });
    vi.mocked(getGitHubUser).mockResolvedValue({ id: 583231, login: "octocat" });
    vi.mocked(listGitHubUserInstallations).mockResolvedValue([
      { account: { id: 99, login: "elsewhere", type: "Organization" }, id: 67890, repository_selection: "all" },
    ]);
    vi.mocked(listConnectedIntegrationAccounts).mockResolvedValue([
      { externalAccountId: "12345", id: "30000000-0000-4000-8000-000000000000" },
    ]);

    const response = await app.request(
      "/api/integrations/github/callback?code=one-time-code&state=author-state",
    );

    expect(response.headers.get("location")).toBe(
      "https://responder.example/settings/workspace?integration=github&status=error&reason=no_shared_installation",
    );
    expect(setGitHubPullRequestAuthor).not.toHaveBeenCalled();
  });

  it("lets only the member or an admin stop it", async () => {
    vi.mocked(getGitHubPullRequestAuthor).mockResolvedValue({
      githubLogin: "octocat",
      status: "connected",
      updatedAt: new Date("2026-10-15T12:00:00Z"),
      user: { email: "other@example.com", id: "40000000-0000-4000-8000-000000000000", name: "Other" },
    });

    const member = await app.request("/api/integrations/github/pull-request-author", { method: "DELETE" });
    expect(member.status).toBe(403);
    expect(removeGitHubPullRequestAuthor).not.toHaveBeenCalled();

    vi.mocked(getActiveTenant).mockResolvedValue({ ...tenant, role: "admin" });
    const admin = await app.request("/api/integrations/github/pull-request-author", { method: "DELETE" });
    expect(admin.status).toBe(204);
    expect(removeGitHubPullRequestAuthor).toHaveBeenCalledWith(tenant.organizationId);
  });
});
