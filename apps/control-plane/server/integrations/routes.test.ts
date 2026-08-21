import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decryptCredentials,
  encryptCredentials,
} from "../../../../packages/core/src/credentials/encryption.js";
import {
  consumeIntegrationConnectionState,
  createIntegrationConnectionState,
  getOrganizationIntegrationAccount,
  getOrganizationIntegrationAccountByExternalId,
  getRecoverableSentryIntegrationAccount,
  listConnectedSentryIntegrationAccounts,
  listOrganizationIntegrationAccounts,
  replaceIntegrationResources,
  replaceIntegrationResourcesIfCredentialsMatch,
  setIntegrationAccountStatus,
  setIntegrationAccountStatusIfCredentialsMatch,
  updateIntegrationAccountCredentials,
  updateIntegrationConnectionStateMetadata,
  upsertIntegrationAccount,
  withIntegrationAccountCredentialLease,
} from "../../../../packages/core/src/db/integrations.js";
import {
  createAwsCloudFormationTemplateUrl,
  createAwsExternalId,
  verifyAwsInvestigationRole,
} from "../../../../packages/core/src/integrations/aws.js";
import {
  beginCustomMcpOAuth,
  finishCustomMcpOAuth,
  parseCustomMcpCredentials,
  validateCustomMcpUrl,
  verifyCustomMcpConnection,
} from "../../../../packages/core/src/integrations/custom-mcp.js";
import {
  createLinearPkce,
  exchangeLinearOAuthCode,
  getLinearWorkspace,
  linearAuthorizeUrl,
} from "../../../../packages/core/src/integrations/linear.js";
import { langfuseProject } from "./langfuse.js";
import { getActiveTenant } from "../tenant.js";
import {
  customMcpConnectionMetricEvent,
  integrationRoutes,
} from "./routes.js";

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
  getOrganizationIntegrationAccount: vi.fn(),
  getOrganizationIntegrationAccountByExternalId: vi.fn(),
  getRecoverableSentryIntegrationAccount: vi.fn(),
  listConnectedSentryIntegrationAccounts: vi.fn(),
  listOrganizationIntegrationAccounts: vi.fn(),
  replaceIntegrationResources: vi.fn(),
  replaceIntegrationResourcesIfCredentialsMatch: vi.fn(),
  replaceRepositories: vi.fn(),
  setIntegrationAccountStatus: vi.fn(),
  setIntegrationAccountStatusIfCredentialsMatch: vi.fn(),
  updateIntegrationAccountCredentials: vi.fn(),
  updateIntegrationConnectionStateMetadata: vi.fn(),
  upsertIntegrationAccount: vi.fn(),
  withIntegrationAccountCredentialLease: vi.fn(),
}));

vi.mock("../../../../packages/core/src/integrations/aws.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../../packages/core/src/integrations/aws.js")
  >();
  return {
    ...actual,
    createAwsCloudFormationTemplateUrl: vi.fn(),
    createAwsExternalId: vi.fn(),
    verifyAwsInvestigationRole: vi.fn(),
  };
});

vi.mock("../../../../packages/core/src/integrations/custom-mcp.js", () => ({
  beginCustomMcpOAuth: vi.fn(),
  finishCustomMcpOAuth: vi.fn(),
  parseCustomMcpCredentials: vi.fn(),
  safeCustomMcpFetch: vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, init)
  ),
  validateCustomMcpUrl: vi.fn(),
  verifyCustomMcpConnection: vi.fn(),
}));

vi.mock("../../../../packages/core/src/integrations/linear.js", () => ({
  createLinearPkce: vi.fn(),
  exchangeLinearOAuthCode: vi.fn(),
  getLinearWorkspace: vi.fn(),
  LINEAR_AUTH_VERSION: "linear_oauth_v1",
  LINEAR_MCP_URL: "https://mcp.linear.app/mcp",
  LINEAR_READONLY_MCP_URL: "https://mcp.linear.app/mcp/readonly",
  linearAuthorizeUrl: vi.fn(),
}));

vi.mock("./langfuse.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./langfuse.js")>();
  return {
    ...actual,
    langfuseProject: vi.fn(),
  };
});

vi.mock("../tenant.js", () => ({
  getActiveTenant: vi.fn(),
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

describe("integration callback routing", () => {
  beforeEach(() => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(replaceIntegrationResourcesIfCredentialsMatch).mockResolvedValue(
      true,
    );
    vi.mocked(withIntegrationAccountCredentialLease).mockImplementation(
      async (input) => {
        const result = await input.operation("encrypted-credentials");
        return result.value;
      },
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("embeds the Responder callback route in Sentry connection state", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.stubEnv("SENTRY_APP_SLUG", "responder-test");
    vi.stubEnv("SENTRY_CLIENT_ID", "sentry-client");
    vi.stubEnv("SENTRY_CLIENT_SECRET", "sentry-secret");
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(getRecoverableSentryIntegrationAccount).mockResolvedValue({
      id: "30000000-0000-4000-8000-000000000000",
      encryptedCredentials: null,
      externalAccountId: "40000000-0000-4000-8000-000000000000",
      metadata: {},
    });
    vi.mocked(createIntegrationConnectionState).mockResolvedValue("routed-state");

    const response = await app.request("/api/integrations/sentry/start");

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).searchParams.get("state"))
      .toBe("routed-state");
    expect(createIntegrationConnectionState).toHaveBeenCalledWith({
      organizationId: "10000000-0000-4000-8000-000000000000",
      userId: "20000000-0000-4000-8000-000000000000",
      provider: "sentry",
      returnTo: undefined,
      routingUrl: "https://responder.example/api/integrations/sentry/callback",
    });
  });

  it("starts a fresh Sentry authorization when reconnecting", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.stubEnv("SENTRY_APP_SLUG", "responder-test");
    vi.stubEnv("SENTRY_CLIENT_ID", "sentry-client");
    vi.stubEnv("SENTRY_CLIENT_SECRET", "sentry-secret");
    vi.mocked(createIntegrationConnectionState).mockResolvedValue("fresh-state");

    const response = await app.request(
      "/api/integrations/sentry/start?mode=reconnect",
    );

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).searchParams.get("state"))
      .toBe("fresh-state");
    expect(getRecoverableSentryIntegrationAccount).not.toHaveBeenCalled();
  });

  it("falls back to fresh Sentry authorization when an old retry fails", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.stubEnv("SENTRY_APP_SLUG", "responder-test");
    vi.stubEnv("SENTRY_CLIENT_ID", "sentry-client");
    vi.stubEnv("SENTRY_CLIENT_SECRET", "sentry-secret");
    vi.mocked(getRecoverableSentryIntegrationAccount).mockResolvedValue({
      id: "30000000-0000-4000-8000-000000000000",
      encryptedCredentials: "broken-credentials",
      externalAccountId: "40000000-0000-4000-8000-000000000000",
      metadata: { organizationSlug: "example" },
    });
    vi.mocked(decryptCredentials).mockImplementation(() => {
      throw new Error("cannot decrypt");
    });
    vi.mocked(createIntegrationConnectionState).mockResolvedValue("fresh-state");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.request("/api/integrations/sentry/start");

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).searchParams.get("state"))
      .toBe("fresh-state");
    expect(setIntegrationAccountStatusIfCredentialsMatch).toHaveBeenCalledWith({
      encryptedCredentials: "broken-credentials",
      integrationAccountId: "30000000-0000-4000-8000-000000000000",
      organizationId: tenant.organizationId,
      provider: "sentry",
      status: "error",
    });
  });

  it("checks a connected Sentry account against the live projects API", async () => {
    vi.mocked(listConnectedSentryIntegrationAccounts).mockResolvedValue([
      {
        id: "30000000-0000-4000-8000-000000000000",
        encryptedCredentials: "encrypted-credentials",
        metadata: { organizationSlug: "example" },
      },
    ]);
    vi.mocked(decryptCredentials).mockReturnValue({
      accessToken: "sentry-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      installationId: "40000000-0000-4000-8000-000000000000",
      refreshToken: "sentry-refresh-token",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json([
          { id: "1", name: "Backend", platform: "node", slug: "backend" },
        ]),
      ),
    );

    const response = await app.request("/api/integrations/sentry/check", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accounts: [
        {
          id: "30000000-0000-4000-8000-000000000000",
          resourceCount: 1,
          status: "working",
        },
      ],
    });
    expect(replaceIntegrationResourcesIfCredentialsMatch).toHaveBeenCalledWith({
      encryptedCredentials: "encrypted-credentials",
      integrationAccountId: "30000000-0000-4000-8000-000000000000",
      kind: "sentry_project",
      organizationId: tenant.organizationId,
      provider: "sentry",
      resources: [
        {
          displayName: "Backend",
          externalId: "1",
          metadata: {
            organizationSlug: "example",
            platform: "node",
            slug: "backend",
          },
        },
      ],
    });
  });

  it("discards a Sentry check superseded by reconnect", async () => {
    vi.mocked(listConnectedSentryIntegrationAccounts).mockResolvedValue([
      {
        id: "30000000-0000-4000-8000-000000000000",
        encryptedCredentials: "encrypted-credentials",
        metadata: { organizationSlug: "example" },
      },
    ]);
    vi.mocked(decryptCredentials).mockReturnValue({
      accessToken: "sentry-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      installationId: "40000000-0000-4000-8000-000000000000",
      refreshToken: "sentry-refresh-token",
    });
    vi.mocked(replaceIntegrationResourcesIfCredentialsMatch).mockResolvedValue(
      false,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json([
          { id: "1", name: "Backend", platform: "node", slug: "backend" },
        ]),
      ),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.request("/api/integrations/sentry/check", {
      method: "POST",
    });

    expect(await response.json()).toEqual({
      accounts: [
        {
          id: "30000000-0000-4000-8000-000000000000",
          status: "unavailable",
        },
      ],
    });
  });

  it("marks a Sentry account for reconnect after a live authorization failure", async () => {
    vi.mocked(listConnectedSentryIntegrationAccounts).mockResolvedValue([
      {
        id: "30000000-0000-4000-8000-000000000000",
        encryptedCredentials: "encrypted-credentials",
        metadata: { organizationSlug: "example" },
      },
    ]);
    vi.mocked(decryptCredentials).mockReturnValue({
      accessToken: "expired-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      installationId: "40000000-0000-4000-8000-000000000000",
      refreshToken: "expired-refresh-token",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.request("/api/integrations/sentry/check", {
      method: "POST",
    });

    expect(await response.json()).toEqual({
      accounts: [
        {
          id: "30000000-0000-4000-8000-000000000000",
          status: "needs_reconnect",
        },
      ],
    });
    expect(setIntegrationAccountStatusIfCredentialsMatch).toHaveBeenCalledWith({
      encryptedCredentials: "encrypted-credentials",
      integrationAccountId: "30000000-0000-4000-8000-000000000000",
      organizationId: tenant.organizationId,
      provider: "sentry",
      status: "error",
    });
  });

  it("does not mark a Sentry account broken during a temporary API failure", async () => {
    vi.mocked(listConnectedSentryIntegrationAccounts).mockResolvedValue([
      {
        id: "30000000-0000-4000-8000-000000000000",
        encryptedCredentials: "encrypted-credentials",
        metadata: { organizationSlug: "example" },
      },
    ]);
    vi.mocked(decryptCredentials).mockReturnValue({
      accessToken: "sentry-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      installationId: "40000000-0000-4000-8000-000000000000",
      refreshToken: "sentry-refresh-token",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.request("/api/integrations/sentry/check", {
      method: "POST",
    });

    expect(await response.json()).toEqual({
      accounts: [
        {
          id: "30000000-0000-4000-8000-000000000000",
          status: "unavailable",
        },
      ],
    });
    expect(setIntegrationAccountStatusIfCredentialsMatch).not.toHaveBeenCalled();
  });

  it("starts Vercel's external installation flow with tenant state", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.stubEnv("VERCEL_INTEGRATION_SLUG", "responder");
    vi.stubEnv("VERCEL_CLIENT_ID", "vercel-client");
    vi.stubEnv("VERCEL_CLIENT_SECRET", "vercel-secret");
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(createIntegrationConnectionState).mockResolvedValue("routed-state");

    const response = await app.request("/api/integrations/vercel/start");

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://vercel.com/integrations/responder/new",
    );
    expect(location.searchParams.get("state")).toBe("routed-state");
    expect(createIntegrationConnectionState).toHaveBeenCalledWith({
      organizationId: tenant.organizationId,
      userId: tenant.user.id,
      provider: "vercel",
      returnTo: undefined,
      routingUrl: "https://responder.example/api/integrations/vercel/callback",
    });
  });

  it("stores a Vercel installation and synchronizes its projects", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.stubEnv("VERCEL_INTEGRATION_SLUG", "responder");
    vi.stubEnv("VERCEL_CLIENT_ID", "vercel-client");
    vi.stubEnv("VERCEL_CLIENT_SECRET", "vercel-secret");
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue({
      organizationId: tenant.organizationId,
      userId: tenant.user.id,
      returnTo: "/agents/new",
      codeVerifier: null,
      metadata: {},
    });
    vi.mocked(encryptCredentials).mockReturnValue("encrypted-credentials");
    vi.mocked(upsertIntegrationAccount).mockResolvedValue(
      "30000000-0000-4000-8000-000000000000",
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            access_token: "vercel-token",
            team_id: "team_1",
            user_id: "user-1",
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            id: "icfg_1",
            projectSelection: "selected",
            projects: ["prj-1"],
            scopes: [
              "read:deployment",
              "read:domain",
              "read:logs",
              "read:project",
            ],
            slug: "responder",
            status: "ready",
            teamId: "team_1",
          }),
        )
        .mockResolvedValueOnce(
          Response.json({ id: "team_1", name: "Acme", slug: "acme" }),
        )
        .mockResolvedValueOnce(
          Response.json({
            projects: [{ id: "prj-1", name: "web", framework: "nextjs" }],
            pagination: { next: null },
          }),
        ),
    );

    const response = await app.request(
      "/api/integrations/vercel/callback" +
        "?code=one-time-code" +
        "&configurationId=icfg_1" +
        "&teamId=team_1" +
        "&state=connection-state",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://responder.example/agents/new" +
        "?integration=vercel" +
        "&status=connected" +
        "&integration_account_id=30000000-0000-4000-8000-000000000000",
    );
    expect(encryptCredentials).toHaveBeenCalledWith({
      accessToken: "vercel-token",
      configurationId: "icfg_1",
      teamId: "team_1",
      userId: "user-1",
    });
    expect(upsertIntegrationAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: tenant.organizationId,
        provider: "vercel",
        externalAccountId: "icfg_1",
        displayName: "Acme",
        encryptedCredentials: "encrypted-credentials",
      }),
    );
    expect(replaceIntegrationResources).toHaveBeenCalledWith(
      "30000000-0000-4000-8000-000000000000",
      "vercel_project",
      [expect.objectContaining({ externalId: "prj-1", displayName: "web" })],
    );
    expect(consumeIntegrationConnectionState).toHaveBeenCalledWith(
      "vercel",
      "connection-state",
      {
        organizationId: tenant.organizationId,
        userId: tenant.user.id,
      },
    );
  });

  it("authenticates and consumes a Vercel denial before returning to its initiating page", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue({
      organizationId: tenant.organizationId,
      userId: tenant.user.id,
      returnTo: "/agents/new",
      codeVerifier: null,
      metadata: {},
    });

    const response = await app.request(
      "/api/integrations/vercel/callback" +
        "?error=access_denied&state=connection-state",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://responder.example/agents/new" +
        "?integration=vercel&status=error&reason=cancelled",
    );
    expect(consumeIntegrationConnectionState).toHaveBeenCalledWith(
      "vercel",
      "connection-state",
      {
        organizationId: tenant.organizationId,
        userId: tenant.user.id,
      },
    );
    expect(upsertIntegrationAccount).not.toHaveBeenCalled();
  });

  it("consumes Vercel state before rejecting malformed callback fields", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue({
      organizationId: tenant.organizationId,
      userId: tenant.user.id,
      returnTo: "/agents/new",
      codeVerifier: null,
      metadata: {},
    });

    const response = await app.request(
      "/api/integrations/vercel/callback" +
        "?configurationId=not-an-installation&state=connection-state",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://responder.example/agents/new" +
        "?integration=vercel&status=error&reason=invalid_callback",
    );
    expect(consumeIntegrationConnectionState).toHaveBeenCalledWith(
      "vercel",
      "connection-state",
      {
        organizationId: tenant.organizationId,
        userId: tenant.user.id,
      },
    );
  });

  it("rejects a Vercel callback whose team differs from the token", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.stubEnv("VERCEL_INTEGRATION_SLUG", "responder");
    vi.stubEnv("VERCEL_CLIENT_ID", "vercel-client");
    vi.stubEnv("VERCEL_CLIENT_SECRET", "vercel-secret");
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue({
      organizationId: tenant.organizationId,
      userId: tenant.user.id,
      returnTo: "/agents/new",
      codeVerifier: null,
      metadata: {},
    });
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        access_token: "vercel-token",
        team_id: "team_other",
        user_id: "user-1",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request(
      "/api/integrations/vercel/callback" +
        "?code=one-time-code&configurationId=icfg_1" +
        "&teamId=team_1&state=connection-state",
    );

    expect(response.status).toBe(302);
    expect(upsertIntegrationAccount).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("accepts Sentry's code-less verified-install completion redirect", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");

    const response = await app.request(
      "/api/integrations/sentry/callback" +
        "?installationId=40000000-0000-4000-8000-000000000000" +
        "&orgSlug=example" +
        "&state=responder-v1.routed-callback.one-time-nonce",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://responder.example/settings?integration=sentry&status=finishing",
    );
    expect(consumeIntegrationConnectionState).not.toHaveBeenCalled();
  });

  it("offers GitHub App installation as the first connection flow", async () => {
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

  it("starts Linear OAuth without replacing the connected account", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.stubEnv("LINEAR_CLIENT_ID", "linear-client");
    vi.stubEnv("LINEAR_CLIENT_SECRET", "linear-secret");
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(createLinearPkce).mockReturnValue({
      codeChallenge: "pkce-challenge",
      codeVerifier: "pkce-verifier",
    });
    vi.mocked(createIntegrationConnectionState).mockResolvedValue("linear-state");
    vi.mocked(linearAuthorizeUrl).mockReturnValue(
      "https://linear.app/oauth/authorize?state=linear-state",
    );

    const response = await app.request(
      "/api/integrations/linear/start?returnTo=%2Fagents%2Fnew",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://linear.app/oauth/authorize?state=linear-state",
    );
    expect(createIntegrationConnectionState).toHaveBeenCalledWith({
      organizationId: tenant.organizationId,
      userId: tenant.user.id,
      provider: "linear",
      codeVerifier: "pkce-verifier",
      returnTo: "/agents/new",
      routingUrl: "https://responder.example/api/integrations/linear/callback",
    });
    expect(linearAuthorizeUrl).toHaveBeenCalledWith({
      codeChallenge: "pkce-challenge",
      redirectUri: "https://responder.example/api/integrations/linear/callback",
      state: "linear-state",
    });
    expect(upsertIntegrationAccount).not.toHaveBeenCalled();
  });

  it("finishes Linear app OAuth before marking the account connected", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.stubEnv("LINEAR_CLIENT_ID", "linear-client");
    vi.stubEnv("LINEAR_CLIENT_SECRET", "linear-secret");
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue({
      organizationId: tenant.organizationId,
      userId: tenant.user.id,
      returnTo: "/agents/new",
      codeVerifier: "pkce-verifier",
      metadata: {},
    });
    vi.mocked(exchangeLinearOAuthCode).mockResolvedValue({
      accessToken: "linear-access-token",
      authType: "linear_oauth",
      expiresAt: Date.now() + 86_400_000,
      mcpUrl: "https://mcp.linear.app/mcp",
      refreshToken: "linear-refresh-token",
      scope: "read write",
      tokenType: "Bearer",
    });
    vi.mocked(getLinearWorkspace).mockResolvedValue({
      id: "linear-workspace-id",
      name: "Example Linear",
    });
    vi.mocked(verifyCustomMcpConnection).mockResolvedValue(12);
    vi.mocked(encryptCredentials).mockReturnValue("encrypted-connected-oauth");
    vi.mocked(upsertIntegrationAccount).mockResolvedValue(
      "30000000-0000-4000-8000-000000000000",
    );

    const response = await app.request(
      "/api/integrations/linear/callback?state=linear-state&code=linear-code",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://responder.example/agents/new" +
        "?integration=linear&status=connected" +
        "&integration_account_id=30000000-0000-4000-8000-000000000000",
    );
    expect(exchangeLinearOAuthCode).toHaveBeenCalledWith({
      authorizationCode: "linear-code",
      codeVerifier: "pkce-verifier",
      redirectUri: "https://responder.example/api/integrations/linear/callback",
    });
    expect(verifyCustomMcpConnection).toHaveBeenCalledWith({
      accessToken: "linear-access-token",
      mcpUrl: "https://mcp.linear.app/mcp/readonly",
    });
    expect(upsertIntegrationAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Example Linear",
        externalAccountId: "linear-workspace-id",
        provider: "linear",
        status: "connected",
      }),
    );
    expect(getOrganizationIntegrationAccount).not.toHaveBeenCalled();
  });

  it("requires the same Responder identity to finish Linear account linking", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(getActiveTenant).mockResolvedValue({
      ...tenant,
      user: {
        ...tenant.user,
        id: "20000000-0000-4000-8000-000000000099",
      },
    });
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue({
      organizationId: tenant.organizationId,
      userId: tenant.user.id,
      returnTo: "/agents/new",
      codeVerifier: "pkce-verifier",
      metadata: {},
    });

    const response = await app.request(
      "/api/integrations/linear/callback?state=linear-state&code=linear-code",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://responder.example/settings" +
        "?integration=linear&status=error&reason=invalid_state",
    );
    expect(exchangeLinearOAuthCode).not.toHaveBeenCalled();
    expect(upsertIntegrationAccount).not.toHaveBeenCalled();
  });

  it("does not consume Linear connection state without a Responder session", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(getActiveTenant).mockResolvedValue({
      ok: false,
      error: "Unauthorized",
      status: 401,
    });

    const response = await app.request(
      "/api/integrations/linear/callback?state=linear-state&code=linear-code",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://responder.example/settings" +
        "?integration=linear&status=error&reason=invalid_state",
    );
    expect(consumeIntegrationConnectionState).not.toHaveBeenCalled();
    expect(exchangeLinearOAuthCode).not.toHaveBeenCalled();
  });

  it.each([
    [
      "axiom",
      "/api/integrations/axiom/callback?state=oauth-state&code=oauth-code",
    ],
    [
      "custom_mcp",
      "/api/integrations/custom_mcp/callback?state=oauth-state&code=oauth-code",
    ],
    [
      "linear",
      "/api/integrations/linear/callback?state=oauth-state&code=oauth-code",
    ],
    [
      "clickstack",
      "/api/integrations/clickstack/callback?state=oauth-state&code=oauth-code",
    ],
    [
      "sentry",
      "/api/integrations/sentry/callback?state=oauth-state&code=oauth-code" +
        "&installationId=40000000-0000-4000-8000-000000000000&orgSlug=example",
    ],
    [
      "slack",
      "/api/integrations/slack/callback?state=oauth-state&code=oauth-code",
    ],
    [
      "github",
      "/api/integrations/github/callback?state=oauth-state&code=oauth-code",
    ],
    [
      "vercel",
      "/api/integrations/vercel/callback?state=oauth-state&code=oauth-code" +
        "&configurationId=icfg_1",
    ],
  ])("rejects a %s callback completed by a different Responder identity", async (
    provider,
    callbackUrl,
  ) => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue({
      organizationId: tenant.organizationId,
      userId: "20000000-0000-4000-8000-000000000099",
      returnTo: "/agents/new",
      codeVerifier: "pkce-verifier",
      metadata: {},
    });

    const response = await app.request(callbackUrl);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `https://responder.example/settings?integration=${provider}` +
        "&status=error&reason=invalid_state",
    );
    expect(consumeIntegrationConnectionState).toHaveBeenCalledWith(
      provider,
      "oauth-state",
      {
        organizationId: tenant.organizationId,
        userId: tenant.user.id,
      },
    );
    expect(upsertIntegrationAccount).not.toHaveBeenCalled();
  });

  it("offers GitHub authorization when an installation already exists", async () => {
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

  it("offers a fresh Sentry reconnect when an account already exists", async () => {
    vi.stubEnv("SENTRY_APP_SLUG", "responder-test");
    vi.stubEnv("SENTRY_CLIENT_ID", "sentry-client");
    vi.stubEnv("SENTRY_CLIENT_SECRET", "sentry-secret");
    vi.mocked(listOrganizationIntegrationAccounts).mockResolvedValue([
      {
        id: "30000000-0000-4000-8000-000000000000",
        provider: "sentry",
        externalAccountId: "40000000-0000-4000-8000-000000000000",
        displayName: "example",
        status: "error",
        metadata: { organizationSlug: "example" },
        updatedAt: new Date("2026-08-18T08:38:21Z"),
        resourceCount: 2,
      },
    ]);

    const response = await app.request("/api/integrations");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.integrations).toContainEqual(
      expect.objectContaining({
        id: "sentry",
        connectUrl: "/api/integrations/sentry/start?mode=reconnect",
      }),
    );
  });

  it("reports a misconfigured GitHub client without logging provider details", async () => {
    configureGitHub();
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue({
      organizationId: tenant.organizationId,
      userId: tenant.user.id,
      returnTo: "/agents/new",
      codeVerifier: null,
      metadata: {},
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          error: "incorrect_client_credentials",
          error_description: "The client secret was rejected",
        }),
      ),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.request(
      "/api/integrations/github/callback" +
        "?code=one-time-code" +
        "&installation_id=12345" +
        "&setup_action=install" +
        "&state=connection-state",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://responder.example/agents/new" +
        "?integration=github" +
        "&status=error" +
        "&reason=integration_misconfigured",
    );
    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({
        error:
          "GitHub OAuth token exchange failed: incorrect_client_credentials",
        event: "integration_callback_failed",
        provider: "github",
      }),
    );
    expect(errorLog).not.toHaveBeenCalledWith(
      expect.stringContaining("The client secret was rejected"),
    );
  });

  it("offers the Datadog API key connection endpoint", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(listOrganizationIntegrationAccounts).mockResolvedValue([]);

    const response = await app.request("/api/integrations");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.integrations).toContainEqual(
      expect.objectContaining({
        id: "datadog",
        connectUrl: "/api/integrations/datadog/connect",
      }),
    );
  });

  it("offers the Axiom OAuth connection endpoint", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(listOrganizationIntegrationAccounts).mockResolvedValue([]);

    const response = await app.request("/api/integrations");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.integrations).toContainEqual(
      expect.objectContaining({
        id: "axiom",
        connectUrl: "/api/integrations/axiom/start",
      }),
    );
  });

  it("offers the Upstash account connection endpoint", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(listOrganizationIntegrationAccounts).mockResolvedValue([]);

    const response = await app.request("/api/integrations");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.integrations).toContainEqual(
      expect.objectContaining({
        id: "upstash",
        connectUrl: "/api/integrations/upstash/connect",
      }),
    );
  });

  it("offers the Langfuse project connection endpoint", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(listOrganizationIntegrationAccounts).mockResolvedValue([]);

    const response = await app.request("/api/integrations");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.integrations).toContainEqual(
      expect.objectContaining({
        id: "langfuse",
        connectUrl: "/api/integrations/langfuse/connect",
      }),
    );
  });

  it("offers custom MCP connections", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(listOrganizationIntegrationAccounts).mockResolvedValue([]);

    const response = await app.request("/api/integrations");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.integrations).toContainEqual(
      expect.objectContaining({
        id: "custom_mcp",
        connectUrl: "/api/integrations/custom-mcp/connect",
      }),
    );
  });

  it("prepares AWS quick create with a presigned S3 template", async () => {
    vi.stubEnv(
      "AWS_INTEGRATION_PRINCIPAL_ARN",
      "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
    );
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(createAwsExternalId).mockReturnValue(
      "responder_abcdefghijklmnopqrstuvwxyz1234567890",
    );
    vi.mocked(createAwsCloudFormationTemplateUrl).mockResolvedValue(
      "https://responder-templates.s3.eu-west-3.amazonaws.com/responder-aws-access.yaml?X-Amz-Signature=test",
    );
    vi.mocked(encryptCredentials).mockReturnValue("encrypted-aws-credentials");
    vi.mocked(upsertIntegrationAccount).mockResolvedValue(
      "30000000-0000-4000-8000-000000000000",
    );

    const response = await app.request("/api/integrations/aws/connect", {
      body: JSON.stringify({ accountId: "123456789012" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.accountId).toBe("30000000-0000-4000-8000-000000000000");
    expect(body.cloudFormationUrl).toContain("#/stacks/create/review?");
    expect(body.cloudFormationUrl).toContain(
      encodeURIComponent(
        "https://responder-templates.s3.eu-west-3.amazonaws.com/responder-aws-access.yaml?X-Amz-Signature=test",
      ),
    );
    expect(body.template).toContain("AIOpsAssistantPolicy");
    expect(body.template).toContain(
      "Default: 'arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker'",
    );
    expect(body.template).toContain(
      "Default: 'responder_abcdefghijklmnopqrstuvwxyz1234567890'",
    );
    expect(body.cloudFormationUrl).not.toContain("ngrok");
    expect(encryptCredentials).toHaveBeenCalledWith({
      accountId: "123456789012",
      externalId: "responder_abcdefghijklmnopqrstuvwxyz1234567890",
      roleArn:
        "arn:aws:iam::123456789012:role/ResponderInvestigationRole",
    });
  });

  it("reuses an existing connected AWS role without rotating its external ID", async () => {
    vi.stubEnv(
      "AWS_INTEGRATION_PRINCIPAL_ARN",
      "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
    );
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(getOrganizationIntegrationAccountByExternalId).mockResolvedValue({
      encryptedCredentials: "existing-encrypted-credentials",
      id: "30000000-0000-4000-8000-000000000000",
      metadata: {},
      status: "connected",
    });
    vi.mocked(decryptCredentials).mockReturnValue({
      accountId: "123456789012",
      externalId: "responder_existing_external_id_1234567890",
      roleArn: "arn:aws:iam::123456789012:role/ResponderInvestigationRole",
    });
    vi.mocked(createAwsCloudFormationTemplateUrl).mockResolvedValue(null);

    const response = await app.request("/api/integrations/aws/connect", {
      body: JSON.stringify({ accountId: "123456789012" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.accountId).toBe("30000000-0000-4000-8000-000000000000");
    expect(body.template).toContain(
      "Default: 'responder_existing_external_id_1234567890'",
    );
    expect(createAwsExternalId).not.toHaveBeenCalled();
    expect(upsertIntegrationAccount).not.toHaveBeenCalled();
  });

  it("replaces unreadable AWS credentials so the connection can recover", async () => {
    vi.stubEnv(
      "AWS_INTEGRATION_PRINCIPAL_ARN",
      "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
    );
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(getOrganizationIntegrationAccountByExternalId).mockResolvedValue({
      encryptedCredentials: "unreadable-credentials",
      id: "30000000-0000-4000-8000-000000000000",
      metadata: {},
      status: "connected",
    });
    vi.mocked(decryptCredentials).mockImplementation(() => {
      throw new Error("Unable to decrypt credentials");
    });
    vi.mocked(createAwsExternalId).mockReturnValue(
      "responder_replacement_external_id_1234567890",
    );
    vi.mocked(encryptCredentials).mockReturnValue("replacement-credentials");
    vi.mocked(upsertIntegrationAccount).mockResolvedValue(
      "30000000-0000-4000-8000-000000000000",
    );
    vi.mocked(createAwsCloudFormationTemplateUrl).mockResolvedValue(null);

    const response = await app.request("/api/integrations/aws/connect", {
      body: JSON.stringify({ accountId: "123456789012" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(upsertIntegrationAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        encryptedCredentials: "replacement-credentials",
        status: "pending",
      }),
    );
  });

  it("keeps template download available without S3 configuration", async () => {
    vi.stubEnv(
      "AWS_INTEGRATION_PRINCIPAL_ARN",
      "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
    );
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(createAwsExternalId).mockReturnValue(
      "responder_abcdefghijklmnopqrstuvwxyz1234567890",
    );
    vi.mocked(createAwsCloudFormationTemplateUrl).mockResolvedValue(null);
    vi.mocked(encryptCredentials).mockReturnValue("encrypted-aws-credentials");
    vi.mocked(upsertIntegrationAccount).mockResolvedValue(
      "30000000-0000-4000-8000-000000000000",
    );

    const response = await app.request("/api/integrations/aws/connect", {
      body: JSON.stringify({ accountId: "123456789012" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cloudFormationUrl: null,
      template: expect.stringContaining("ResponderInvestigationRole"),
    });
  });

  it("verifies the customer role before connecting AWS", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(getOrganizationIntegrationAccount).mockResolvedValue({
      encryptedCredentials: "encrypted-aws-credentials",
      id: "30000000-0000-4000-8000-000000000000",
      metadata: {},
      status: "pending",
    });
    vi.mocked(decryptCredentials).mockReturnValue({
      accountId: "123456789012",
      externalId: "responder_abcdefghijklmnopqrstuvwxyz1234567890",
      roleArn:
        "arn:aws:iam::123456789012:role/ResponderInvestigationRole",
    });
    vi.mocked(verifyAwsInvestigationRole).mockResolvedValue(undefined);
    vi.mocked(setIntegrationAccountStatus).mockResolvedValue(undefined);

    const response = await app.request("/api/integrations/aws/verify", {
      body: JSON.stringify({
        integrationAccountId: "30000000-0000-4000-8000-000000000000",
        returnTo: "/agents/new",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(verifyAwsInvestigationRole).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "123456789012" }),
    );
    expect(setIntegrationAccountStatus).toHaveBeenCalledWith(
      "30000000-0000-4000-8000-000000000000",
      "connected",
    );
    await expect(response.json()).resolves.toMatchObject({
      redirectUrl:
        "https://responder.example/agents/new?integration=aws&status=connected&integration_account_id=30000000-0000-4000-8000-000000000000",
    });
  });

  it("validates and encrypts a custom MCP API token", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(validateCustomMcpUrl).mockResolvedValue(
      new URL("https://mcp.example.com/mcp"),
    );
    vi.mocked(verifyCustomMcpConnection).mockResolvedValue(7);
    vi.mocked(encryptCredentials).mockReturnValue("encrypted-credentials");
    vi.mocked(upsertIntegrationAccount).mockResolvedValue(
      "30000000-0000-4000-8000-000000000000",
    );
    const metricLog = vi.spyOn(console, "info").mockImplementation(() => {});

    const response = await app.request("/api/integrations/custom-mcp/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        apiToken: "secret-token",
        authType: "api_token",
        displayName: "Production metrics",
        mcpUrl: "https://mcp.example.com/mcp",
        returnTo: "/agents/new",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      accountId: "30000000-0000-4000-8000-000000000000",
      redirectUrl:
        "https://responder.example/agents/new?integration=custom_mcp&status=connected&integration_account_id=30000000-0000-4000-8000-000000000000",
    });
    expect(verifyCustomMcpConnection).toHaveBeenCalledWith({
      accessToken: "secret-token",
      mcpUrl: "https://mcp.example.com/mcp",
    });
    expect(encryptCredentials).toHaveBeenCalledWith({
      apiToken: "secret-token",
      authType: "api_token",
      mcpUrl: "https://mcp.example.com/mcp",
    });
    expect(upsertIntegrationAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Production metrics",
        externalAccountId: "https://mcp.example.com/mcp",
        organizationId: tenant.organizationId,
        provider: "custom_mcp",
      }),
    );
    expect(metricLog.mock.calls.flat().join(" ")).toContain(
      '"outcome":"connected"',
    );
  });

  it("logs a useful custom MCP failure without echoing remote secrets", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(validateCustomMcpUrl).mockResolvedValue(
      new URL("https://mcp.example.com/mcp"),
    );
    vi.mocked(verifyCustomMcpConnection).mockRejectedValue(
      new Error("remote response echoed secret-token"),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const metricLog = vi.spyOn(console, "info").mockImplementation(() => {});

    const response = await app.request("/api/integrations/custom-mcp/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        apiToken: "secret-token",
        authType: "api_token",
        displayName: "Production metrics",
        mcpUrl: "https://mcp.example.com/mcp",
      }),
    });

    expect(response.status).toBe(502);
    const logged = errorLog.mock.calls.flat().join(" ");
    expect(logged).toContain('"message":"Error"');
    expect(logged).not.toContain("secret-token");
    expect(metricLog.mock.calls.flat().join(" ")).toContain(
      '"outcome":"verify_failed"',
    );
  });

  it("counts invalid custom MCP connection requests", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    const metricLog = vi.spyOn(console, "info").mockImplementation(() => {});

    const response = await app.request("/api/integrations/custom-mcp/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authType: "api_token" }),
    });

    expect(response.status).toBe(400);
    expect(metricLog.mock.calls.flat().join(" ")).toContain(
      '"outcome":"validation_failed"',
    );
  });

  it("starts custom MCP OAuth with tenant-bound state", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(validateCustomMcpUrl).mockResolvedValue(
      new URL("https://mcp.example.com/mcp"),
    );
    vi.mocked(encryptCredentials).mockReturnValue("encrypted-credentials");
    vi.mocked(upsertIntegrationAccount).mockResolvedValue(
      "30000000-0000-4000-8000-000000000000",
    );
    vi.mocked(createIntegrationConnectionState).mockResolvedValue("oauth-state");
    vi.mocked(beginCustomMcpOAuth).mockResolvedValue({
      authorizationUrl: "https://auth.example.com/authorize?state=oauth-state",
      oauth: { codeVerifier: "pkce-verifier" },
    });
    vi.mocked(updateIntegrationAccountCredentials).mockResolvedValue(true);
    const metricLog = vi.spyOn(console, "info").mockImplementation(() => {});

    const response = await app.request("/api/integrations/custom-mcp/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authType: "oauth",
        displayName: "Production metrics",
        mcpUrl: "https://mcp.example.com/mcp",
        returnTo: "/agents/new",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      redirectUrl: "https://auth.example.com/authorize?state=oauth-state",
    });
    expect(createIntegrationConnectionState).toHaveBeenCalledWith({
      organizationId: tenant.organizationId,
      userId: tenant.user.id,
      provider: "custom_mcp",
      codeVerifier: JSON.stringify({
        accountId: "30000000-0000-4000-8000-000000000000",
      }),
      returnTo: "/agents/new",
    });
    expect(updateIntegrationAccountCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationAccountId: "30000000-0000-4000-8000-000000000000",
        organizationId: tenant.organizationId,
        provider: "custom_mcp",
        status: "pending",
      }),
    );
    expect(metricLog.mock.calls.flat().join(" ")).toContain(
      '"outcome":"oauth_started"',
    );
  });

  it("logs the account ID when custom MCP OAuth setup fails", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(validateCustomMcpUrl).mockResolvedValue(
      new URL("https://mcp.example.com/mcp"),
    );
    vi.mocked(encryptCredentials).mockReturnValue("encrypted-credentials");
    vi.mocked(upsertIntegrationAccount).mockResolvedValue(
      "30000000-0000-4000-8000-000000000000",
    );
    vi.mocked(createIntegrationConnectionState).mockResolvedValue("oauth-state");
    vi.mocked(beginCustomMcpOAuth).mockRejectedValue(new Error("OAuth failed"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});

    const response = await app.request("/api/integrations/custom-mcp/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authType: "oauth",
        displayName: "Production metrics",
        mcpUrl: "https://mcp.example.com/mcp",
      }),
    });

    expect(response.status).toBe(502);
    expect(errorLog.mock.calls.flat().join(" ")).toContain(
      '"accountId":"30000000-0000-4000-8000-000000000000"',
    );
  });

  it("builds a low-cardinality CloudWatch counter event", () => {
    expect(customMcpConnectionMetricEvent("connected", 123)).toEqual({
      _aws: {
        Timestamp: 123,
        CloudWatchMetrics: [
          {
            Dimensions: [["outcome"]],
            Metrics: [{ Name: "custom_mcp.connection.total", Unit: "Count" }],
            Namespace: "Responder",
          },
        ],
      },
      outcome: "connected",
      "custom_mcp.connection.total": 1,
    });
  });

  it("finishes custom MCP OAuth for the account bound to state", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue({
      organizationId: tenant.organizationId,
      userId: tenant.user.id,
      returnTo: "/agents/new",
      metadata: {},
      codeVerifier: JSON.stringify({
        accountId: "30000000-0000-4000-8000-000000000000",
      }),
    });
    vi.mocked(getOrganizationIntegrationAccount).mockResolvedValue({
      id: "30000000-0000-4000-8000-000000000000",
      encryptedCredentials: "encrypted-pending-credentials",
      metadata: {},
      status: "pending",
    });
    vi.mocked(decryptCredentials).mockReturnValue({ pending: true });
    vi.mocked(parseCustomMcpCredentials).mockReturnValue({
      authType: "oauth",
      mcpUrl: "https://mcp.example.com/mcp",
      oauth: { codeVerifier: "pkce-verifier" },
    });
    vi.mocked(finishCustomMcpOAuth).mockResolvedValue({
      tokens: { access_token: "oauth-access-token", token_type: "bearer" },
    });
    vi.mocked(verifyCustomMcpConnection).mockResolvedValue(4);
    vi.mocked(encryptCredentials).mockReturnValue("encrypted-final-credentials");
    vi.mocked(updateIntegrationAccountCredentials).mockResolvedValue(true);

    const response = await app.request(
      "/api/integrations/custom_mcp/callback?code=authorization-code&state=oauth-state",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://responder.example/agents/new?integration=custom_mcp&status=connected&integration_account_id=30000000-0000-4000-8000-000000000000",
    );
    expect(getOrganizationIntegrationAccount).toHaveBeenCalledWith({
      integrationAccountId: "30000000-0000-4000-8000-000000000000",
      organizationId: tenant.organizationId,
      provider: "custom_mcp",
    });
    expect(finishCustomMcpOAuth).toHaveBeenCalledWith({
      authorizationCode: "authorization-code",
      mcpUrl: "https://mcp.example.com/mcp",
      oauth: { codeVerifier: "pkce-verifier" },
      redirectUrl:
        "https://responder.example/api/integrations/custom_mcp/callback",
    });
    expect(updateIntegrationAccountCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        encryptedCredentials: "encrypted-final-credentials",
        integrationAccountId: "30000000-0000-4000-8000-000000000000",
        organizationId: tenant.organizationId,
        provider: "custom_mcp",
        status: "connected",
      }),
    );
  });

  it("logs an expired custom MCP OAuth state before redirecting", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue(null);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.request(
      "/api/integrations/custom_mcp/callback?code=authorization-code&state=expired-state",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://responder.example/settings?integration=custom_mcp&status=error&reason=invalid_state",
    );
    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({
        event: "integration_oauth_state_invalid",
        provider: "custom_mcp",
        reason: "missing_or_expired",
      }),
    );
  });

  it("logs a failed custom MCP OAuth state lookup before redirecting", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(consumeIntegrationConnectionState).mockRejectedValue(
      new Error("Database unavailable"),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.request(
      "/api/integrations/custom_mcp/callback?code=authorization-code&state=oauth-state",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://responder.example/settings?integration=custom_mcp&status=error&reason=connection_failed",
    );
    expect(errorLog.mock.calls.flat().join(" ")).toContain(
      '"event":"custom_mcp_connection_failed"',
    );
  });

  it("logs a failed OAuth account status update and preserves the redirect", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue({
      organizationId: tenant.organizationId,
      userId: tenant.user.id,
      returnTo: "/agents/new",
      metadata: {},
      codeVerifier: JSON.stringify({
        accountId: "30000000-0000-4000-8000-000000000000",
      }),
    });
    vi.mocked(getOrganizationIntegrationAccount).mockResolvedValue({
      id: "30000000-0000-4000-8000-000000000000",
      encryptedCredentials: "encrypted-pending-credentials",
      metadata: {},
      status: "pending",
    });
    vi.mocked(decryptCredentials).mockReturnValue({ pending: true });
    vi.mocked(parseCustomMcpCredentials).mockReturnValue({
      authType: "oauth",
      mcpUrl: "https://mcp.example.com/mcp",
      oauth: { codeVerifier: "pkce-verifier" },
    });
    vi.mocked(finishCustomMcpOAuth).mockRejectedValue(new Error("OAuth failed"));
    vi.mocked(setIntegrationAccountStatus).mockRejectedValue(
      new Error("Database unavailable"),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.request(
      "/api/integrations/custom_mcp/callback?code=authorization-code&state=oauth-state",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://responder.example/agents/new?integration=custom_mcp&status=error&reason=connection_failed",
    );
    expect(errorLog.mock.calls.flat().join(" ")).toContain(
      '"event":"custom_mcp_status_update_failed"',
    );
    expect(errorLog.mock.calls.flat().join(" ")).toContain(
      '"accountId":"30000000-0000-4000-8000-000000000000"',
    );
    expect(errorLog.mock.calls.map(([entry]) => String(entry))).toEqual([
      expect.stringContaining('"event":"custom_mcp_connection_failed"'),
      expect.stringContaining('"event":"custom_mcp_status_update_failed"'),
    ]);
  });

  it("counts an OAuth callback connection verification failure", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue({
      organizationId: tenant.organizationId,
      userId: tenant.user.id,
      returnTo: "/agents/new",
      metadata: {},
      codeVerifier: JSON.stringify({
        accountId: "30000000-0000-4000-8000-000000000000",
      }),
    });
    vi.mocked(getOrganizationIntegrationAccount).mockResolvedValue({
      id: "30000000-0000-4000-8000-000000000000",
      encryptedCredentials: "encrypted-pending-credentials",
      metadata: {},
      status: "pending",
    });
    vi.mocked(decryptCredentials).mockReturnValue({ pending: true });
    vi.mocked(parseCustomMcpCredentials).mockReturnValue({
      authType: "oauth",
      mcpUrl: "https://mcp.example.com/mcp",
      oauth: { codeVerifier: "pkce-verifier" },
    });
    vi.mocked(finishCustomMcpOAuth).mockResolvedValue({
      tokens: { access_token: "oauth-access-token", token_type: "bearer" },
    });
    vi.mocked(verifyCustomMcpConnection).mockRejectedValue(
      new Error("Connection refused"),
    );
    vi.mocked(setIntegrationAccountStatus).mockResolvedValue(undefined);
    const metricLog = vi.spyOn(console, "info").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.request(
      "/api/integrations/custom_mcp/callback?code=authorization-code&state=oauth-state",
    );

    expect(response.status).toBe(302);
    expect(metricLog.mock.calls.flat().join(" ")).toContain(
      '"outcome":"verify_failed"',
    );
    const connectionError = errorLog.mock.calls
      .flat()
      .map(String)
      .find((entry) => entry.includes('"event":"custom_mcp_connection_failed"'));
    expect(connectionError).toContain(
      '"accountId":"30000000-0000-4000-8000-000000000000"',
    );
  });

  it("offers the ClickStack credential connection endpoint", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(listOrganizationIntegrationAccounts).mockResolvedValue([]);

    const response = await app.request("/api/integrations");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.integrations).toContainEqual(
      expect.objectContaining({
        id: "clickstack",
        connectUrl: "/api/integrations/clickstack/connect",
      }),
    );
  });

  it("validates and encrypts Datadog API credentials", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(encryptCredentials).mockReturnValue("encrypted-credentials");
    vi.mocked(upsertIntegrationAccount).mockResolvedValue(
      "30000000-0000-4000-8000-000000000000",
    );
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: {
          id: "user-1",
          attributes: {
            handle: "operator@example.com",
            name: "Operator",
            service_account: false,
          },
          relationships: { org: { data: { id: "org-1" } } },
        },
        included: [
          { id: "org-1", type: "orgs", attributes: { name: "Example EU" } },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request("/api/integrations/datadog/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        apiKey: "api-key",
        applicationKey: "application-key",
        returnTo: "/agents/new",
        site: "datadoghq.eu",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      accountId: "30000000-0000-4000-8000-000000000000",
      redirectUrl:
        "https://responder.example/agents/new?integration=datadog&status=connected",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.datadoghq.eu/api/v2/current_user",
      expect.objectContaining({
        headers: expect.objectContaining({
          "dd-api-key": "api-key",
          "dd-application-key": "application-key",
        }),
      }),
    );
    expect(encryptCredentials).toHaveBeenCalledWith({
      authType: "api_keys",
      apiKey: "api-key",
      applicationKey: "application-key",
      datacenter: "EU1",
      mcpUrl: "https://mcp.datadoghq.eu/v1/mcp",
      site: "datadoghq.eu",
    });
    expect(upsertIntegrationAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        encryptedCredentials: "encrypted-credentials",
        externalAccountId: "org-1",
        organizationId: tenant.organizationId,
        provider: "datadog",
      }),
    );
  });

  it("starts Axiom hosted MCP OAuth", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(encryptCredentials).mockReturnValue("encrypted-credentials");
    vi.mocked(getOrganizationIntegrationAccountByExternalId).mockResolvedValue(
      null as never,
    );
    vi.mocked(upsertIntegrationAccount).mockResolvedValue(
      "30000000-0000-4000-8000-000000000000",
    );
    vi.mocked(createIntegrationConnectionState).mockResolvedValue("oauth-state");
    vi.mocked(beginCustomMcpOAuth).mockResolvedValue({
      authorizationUrl: "https://axiom.example/authorize",
      oauth: { codeVerifier: "pkce-verifier" },
    });
    vi.mocked(updateIntegrationConnectionStateMetadata).mockResolvedValue(true);

    const response = await app.request(
      "/api/integrations/axiom/start?returnTo=%2Fagents%2Fnew",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://axiom.example/authorize",
    );
    expect(createIntegrationConnectionState).toHaveBeenCalledWith({
      codeVerifier: JSON.stringify({
        accountId: "30000000-0000-4000-8000-000000000000",
        preserveExistingAccount: false,
      }),
      organizationId: tenant.organizationId,
      provider: "axiom",
      returnTo: "/agents/new",
      routingUrl: "https://responder.example/api/integrations/axiom/callback",
      userId: tenant.user.id,
    });
    expect(beginCustomMcpOAuth).toHaveBeenCalledWith({
      connectionState: "oauth-state",
      mcpUrl: "https://mcp.axiom.co/mcp",
      redirectUrl: "https://responder.example/api/integrations/axiom/callback",
    });
    expect(updateIntegrationConnectionStateMetadata).toHaveBeenCalledWith({
      metadata: { encryptedCredentials: "encrypted-credentials" },
      organizationId: tenant.organizationId,
      provider: "axiom",
      state: "oauth-state",
      userId: tenant.user.id,
    });
  });

  it("keeps a connected Axiom account active while reconnecting", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(getOrganizationIntegrationAccountByExternalId).mockResolvedValue({
      id: "30000000-0000-4000-8000-000000000000",
      encryptedCredentials: "working-credentials",
      metadata: {},
      status: "connected",
    });
    vi.mocked(createIntegrationConnectionState).mockResolvedValue("oauth-state");
    vi.mocked(beginCustomMcpOAuth).mockRejectedValue(new Error("OAuth failed"));

    const response = await app.request("/api/integrations/axiom/start");

    expect(response.status).toBe(302);
    expect(upsertIntegrationAccount).not.toHaveBeenCalled();
    expect(updateIntegrationAccountCredentials).not.toHaveBeenCalled();
    expect(setIntegrationAccountStatus).not.toHaveBeenCalled();
  });

  it("finishes Axiom OAuth and stores the encrypted MCP session", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue({
      organizationId: tenant.organizationId,
      userId: tenant.user.id,
      returnTo: "/agents/new",
      codeVerifier: JSON.stringify({
        accountId: "30000000-0000-4000-8000-000000000000",
        preserveExistingAccount: false,
      }),
      metadata: { encryptedCredentials: "pending-credentials" },
    });
    vi.mocked(getOrganizationIntegrationAccount).mockResolvedValue({
      id: "30000000-0000-4000-8000-000000000000",
      encryptedCredentials: "encrypted-credentials",
      metadata: {},
      status: "pending",
    });
    vi.mocked(decryptCredentials).mockReturnValue({
      authType: "oauth",
      mcpUrl: "https://mcp.axiom.co/mcp",
      oauth: { codeVerifier: "pkce-verifier" },
    });
    vi.mocked(finishCustomMcpOAuth).mockResolvedValue({
      tokens: { access_token: "oauth-access-token", token_type: "bearer" },
    });
    vi.mocked(verifyCustomMcpConnection).mockResolvedValue(18);
    vi.mocked(encryptCredentials).mockReturnValue("updated-credentials");
    vi.mocked(updateIntegrationAccountCredentials).mockResolvedValue(true);

    const response = await app.request(
      "/api/integrations/axiom/callback?state=oauth-state&code=oauth-code",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://responder.example/agents/new" +
        "?integration=axiom&status=connected" +
        "&integration_account_id=30000000-0000-4000-8000-000000000000",
    );
    expect(finishCustomMcpOAuth).toHaveBeenCalledWith({
      authorizationCode: "oauth-code",
      mcpUrl: "https://mcp.axiom.co/mcp",
      oauth: { codeVerifier: "pkce-verifier" },
      redirectUrl: "https://responder.example/api/integrations/axiom/callback",
    });
    expect(updateIntegrationAccountCredentials).toHaveBeenCalledWith({
      encryptedCredentials: "updated-credentials",
      integrationAccountId: "30000000-0000-4000-8000-000000000000",
      organizationId: tenant.organizationId,
      provider: "axiom",
      status: "connected",
    });
  });

  it("does not disable a connected Axiom account when reconnect is cancelled", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue({
      organizationId: tenant.organizationId,
      userId: tenant.user.id,
      returnTo: "/settings",
      codeVerifier: JSON.stringify({
        accountId: "30000000-0000-4000-8000-000000000000",
        preserveExistingAccount: true,
      }),
      metadata: { encryptedCredentials: "pending-credentials" },
    });

    const response = await app.request(
      "/api/integrations/axiom/callback?state=oauth-state&error=access_denied",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://responder.example/settings" +
        "?integration=axiom&status=error&reason=cancelled",
    );
    expect(setIntegrationAccountStatus).not.toHaveBeenCalled();
  });

  it("validates and encrypts an Upstash account API key", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(encryptCredentials).mockReturnValue("encrypted-credentials");
    vi.mocked(upsertIntegrationAccount).mockResolvedValue(
      "30000000-0000-4000-8000-000000000000",
    );
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json([
        { database_id: "db-1", database_name: "production-cache" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request("/api/integrations/upstash/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        apiKey: "developer-api-key",
        email: "operator@example.com",
        returnTo: "/agents/new",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accountId: "30000000-0000-4000-8000-000000000000",
      redirectUrl:
        "https://responder.example/agents/new?integration=upstash&status=connected&integration_account_id=30000000-0000-4000-8000-000000000000",
    });
    expect(encryptCredentials).toHaveBeenCalledWith({
      apiKey: "developer-api-key",
      authType: "api_key",
      email: "operator@example.com",
    });
    expect(upsertIntegrationAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        encryptedCredentials: "encrypted-credentials",
        externalAccountId: "operator@example.com",
        organizationId: tenant.organizationId,
        provider: "upstash",
      }),
    );
  });

  it("validates and encrypts Langfuse project keys", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(encryptCredentials).mockReturnValue("encrypted-credentials");
    vi.mocked(upsertIntegrationAccount).mockResolvedValue(
      "30000000-0000-4000-8000-000000000000",
    );
    vi.mocked(langfuseProject).mockResolvedValue({
      baseUrl: "https://cloud.langfuse.com",
      displayName: "Example / Production",
      externalAccountId: "https://cloud.langfuse.com:project-1",
      metadata: {
        baseUrl: "https://cloud.langfuse.com",
        organizationId: "org-1",
        organizationName: "Example",
        projectId: "project-1",
        projectName: "Production",
      },
      projectId: "project-1",
    });

    const response = await app.request("/api/integrations/langfuse/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://cloud.langfuse.com",
        publicKey: "pk-lf-public",
        returnTo: "/agents/new",
        secretKey: "sk-lf-secret",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accountId: "30000000-0000-4000-8000-000000000000",
      redirectUrl:
        "https://responder.example/agents/new?integration=langfuse&status=connected&integration_account_id=30000000-0000-4000-8000-000000000000",
    });
    expect(encryptCredentials).toHaveBeenCalledWith({
      authType: "basic",
      baseUrl: "https://cloud.langfuse.com",
      projectId: "project-1",
      publicKey: "pk-lf-public",
      secretKey: "sk-lf-secret",
    });
    expect(upsertIntegrationAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        encryptedCredentials: "encrypted-credentials",
        externalAccountId: "https://cloud.langfuse.com:project-1",
        organizationId: tenant.organizationId,
        provider: "langfuse",
      }),
    );
  });

  it("validates and encrypts a self-hosted ClickStack connection", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(encryptCredentials).mockReturnValue("encrypted-credentials");
    vi.mocked(upsertIntegrationAccount).mockResolvedValue(
      "30000000-0000-4000-8000-000000000000",
    );
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ data: { id: "team-1", name: "Production" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => {});

    const response = await app.request("/api/integrations/clickstack/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accessKey: "personal-access-key",
        deployment: "self_hosted",
        mcpUrl: "https://clickstack.example.com/api/mcp",
        returnTo: "/agents/new",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      accountId: "30000000-0000-4000-8000-000000000000",
      redirectUrl:
        "https://responder.example/agents/new?integration=clickstack&status=connected",
    });
    expect(encryptCredentials).toHaveBeenCalledWith({
      authType: "access_key",
      accessKey: "personal-access-key",
      mcpUrl: "https://clickstack.example.com/api/mcp",
    });
    expect(upsertIntegrationAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        externalAccountId: "https://clickstack.example.com:team-1",
        organizationId: tenant.organizationId,
        provider: "clickstack",
      }),
    );
    expect(infoLog).toHaveBeenCalledWith(
      JSON.stringify({
        accountId: "30000000-0000-4000-8000-000000000000",
        deployment: "self_hosted",
        event: "clickstack_connected",
        organizationId: tenant.organizationId,
        provider: "clickstack",
      }),
    );
  });

  it("logs rejected self-hosted ClickStack credentials with tenant context", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.request("/api/integrations/clickstack/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accessKey: "rejected-access-key",
        deployment: "self_hosted",
        mcpUrl: "https://clickstack.example/api/mcp",
      }),
    });

    expect(response.status).toBe(401);
    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({
        deployment: "self_hosted",
        error: "ClickStack rejected the Personal API Access Key",
        event: "clickstack_connect_failed",
        organizationId: tenant.organizationId,
        provider: "clickstack",
      }),
    );
    expect(errorLog.mock.calls.flat().join(" ")).not.toContain(
      "rejected-access-key",
    );
  });

  it("logs unexpected self-hosted ClickStack failures with tenant context", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ data: {} })),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.request("/api/integrations/clickstack/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accessKey: "personal-access-key",
        deployment: "self_hosted",
        mcpUrl: "https://clickstack.example/api/mcp",
      }),
    });

    expect(response.status).toBe(502);
    expect(JSON.parse(String(errorLog.mock.calls.at(-1)?.[0]))).toMatchObject({
      deployment: "self_hosted",
      error: expect.any(String),
      event: "integration_callback_failed",
      organizationId: tenant.organizationId,
      provider: "clickstack",
    });
    expect(errorLog.mock.calls.flat().join(" ")).not.toContain(
      "personal-access-key",
    );
  });

  it("starts ClickStack Cloud OAuth with PKCE and the managed URL", async () => {
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.example");
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.mocked(createIntegrationConnectionState).mockResolvedValue(
      "connection-state",
    );
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ client_id: "dynamic-client-id" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request("/api/integrations/clickstack/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deployment: "cloud",
        returnTo: "/agents/new",
        serviceId: "60000000-0000-4000-8000-000000000000",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const authorizeUrl = new URL(body.redirectUrl);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      "https://mcp.clickhouse.cloud/authorize",
    );
    expect(authorizeUrl.searchParams.get("client_id")).toBe(
      "dynamic-client-id",
    );
    expect(authorizeUrl.searchParams.get("resource")).toBe(
      "https://mcp.clickhouse.cloud/clickstack",
    );
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(createIntegrationConnectionState).toHaveBeenCalledWith(
      expect.objectContaining({
        codeVerifier: expect.any(String),
        metadata: {
          clientId: "dynamic-client-id",
          serviceId: "60000000-0000-4000-8000-000000000000",
        },
        provider: "clickstack",
        routingUrl:
          "https://responder.example/api/integrations/clickstack/callback",
      }),
    );
  });

  it("logs ClickStack Cloud setup failures with tenant context", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(tenant);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.request("/api/integrations/clickstack/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deployment: "cloud",
        serviceId: "60000000-0000-4000-8000-000000000000",
      }),
    });

    expect(response.status).toBe(502);
    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({
        deployment: "cloud",
        error: "ClickStack client registration failed",
        event: "clickstack_connect_failed",
        organizationId: tenant.organizationId,
        provider: "clickstack",
      }),
    );
  });

  it("stores encrypted ClickStack Cloud OAuth credentials", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue({
      codeVerifier: "pkce-verifier",
      metadata: {
        clientId: "dynamic-client-id",
        serviceId: "60000000-0000-4000-8000-000000000000",
      },
      organizationId: tenant.organizationId,
      returnTo: "/agents/new",
      userId: tenant.user.id,
    });
    vi.mocked(encryptCredentials).mockReturnValue("encrypted-credentials");
    vi.mocked(upsertIntegrationAccount).mockResolvedValue(
      "30000000-0000-4000-8000-000000000000",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          access_token: "cloud-access-token",
          expires_in: 3600,
          refresh_token: "cloud-refresh-token",
          token_type: "Bearer",
        }),
      ),
    );
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => {});

    const response = await app.request(
      "/api/integrations/clickstack/callback?code=oauth-code&state=connection-state",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://responder.example/agents/new" +
        "?integration=clickstack&status=connected",
    );
    expect(encryptCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "cloud-access-token",
        authType: "oauth",
        clientId: "dynamic-client-id",
        mcpUrl: "https://mcp.clickhouse.cloud/clickstack",
        refreshToken: "cloud-refresh-token",
        serviceId: "60000000-0000-4000-8000-000000000000",
      }),
    );
    expect(infoLog).toHaveBeenCalledWith(
      JSON.stringify({
        accountId: "30000000-0000-4000-8000-000000000000",
        deployment: "cloud",
        event: "clickstack_connected",
        organizationId: tenant.organizationId,
        provider: "clickstack",
      }),
    );
  });

  it("logs ClickStack Cloud OAuth denials with tenant context", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue({
      codeVerifier: "pkce-verifier",
      metadata: {
        clientId: "dynamic-client-id",
        serviceId: "60000000-0000-4000-8000-000000000000",
      },
      organizationId: tenant.organizationId,
      returnTo: "/agents/new",
      userId: tenant.user.id,
    });
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => {});

    const response = await app.request(
      "/api/integrations/clickstack/callback" +
        "?error=access_denied&state=connection-state",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "integration=clickstack&status=error&reason=access_denied",
    );
    expect(infoLog).toHaveBeenCalledWith(
      JSON.stringify({
        event: "clickstack_oauth_denied",
        oauthError: "access_denied",
        organizationId: tenant.organizationId,
        provider: "clickstack",
      }),
    );
  });

  it("logs incomplete ClickStack Cloud callbacks with tenant context", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue({
      codeVerifier: "pkce-verifier",
      metadata: {
        clientId: "dynamic-client-id",
        serviceId: "60000000-0000-4000-8000-000000000000",
      },
      organizationId: tenant.organizationId,
      returnTo: "/agents/new",
      userId: tenant.user.id,
    });
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => {});

    const response = await app.request(
      "/api/integrations/clickstack/callback?state=connection-state",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "integration=clickstack&status=error&reason=missing_code",
    );
    expect(infoLog).toHaveBeenCalledWith(
      JSON.stringify({
        event: "clickstack_callback_incomplete",
        organizationId: tenant.organizationId,
        provider: "clickstack",
        reason: "missing_code",
      }),
    );
  });

  it("logs invalid ClickStack Cloud callback metadata", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue({
      codeVerifier: "pkce-verifier",
      metadata: {},
      organizationId: tenant.organizationId,
      returnTo: "/agents/new",
      userId: tenant.user.id,
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.request(
      "/api/integrations/clickstack/callback" +
        "?code=authorization-code&state=connection-state",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "integration=clickstack&status=error&reason=invalid_state",
    );
    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({
        deployment: "cloud",
        error: "invalid_callback_metadata",
        event: "clickstack_callback_invalid_metadata",
        organizationId: tenant.organizationId,
        provider: "clickstack",
      }),
    );
  });

  it("correlates ClickStack Cloud callback failures to the tenant", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.mocked(consumeIntegrationConnectionState).mockResolvedValue({
      codeVerifier: "pkce-verifier",
      metadata: {
        clientId: "dynamic-client-id",
        serviceId: "60000000-0000-4000-8000-000000000000",
      },
      organizationId: tenant.organizationId,
      returnTo: "/agents/new",
      userId: tenant.user.id,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.request(
      "/api/integrations/clickstack/callback?code=authorization-code&state=oauth-state",
    );

    expect(response.status).toBe(302);
    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({
        deployment: "cloud",
        organizationId: tenant.organizationId,
        returnTo: "/agents/new",
        error: "ClickStack authorization failed",
        event: "integration_callback_failed",
        provider: "clickstack",
      }),
    );
  });
});
