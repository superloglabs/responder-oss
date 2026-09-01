import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const dnsMocks = vi.hoisted(() => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

vi.mock("node:dns/promises", () => ({ lookup: dnsMocks.lookup }));

import {
  getIntegrationDefinition,
  integrationIsConfigured,
} from "./catalog.js";
import { getDatadogSite } from "../../../../packages/core/src/integrations/datadog.js";
import {
  datadogAccount,
} from "./datadog.js";
import { upstashAccount } from "./upstash.js";
import { langfuseProject } from "./langfuse.js";
import {
  clickStackAccount,
  exchangeClickStackCloudCode,
  registerClickStackCloudClient,
} from "./clickstack.js";
import {
  exchangeGitHubCode,
  GitHubOAuthError,
  githubAuthorizeUrl,
  githubInstallUrl,
} from "./github.js";
import {
  listSentryProjects,
  refreshSentryGrant,
  sentryInstallUrl,
} from "./sentry.js";
import {
  exchangeSlackCode,
  joinSlackChannel,
  SlackChannelJoinError,
  slackAuthorizeUrl,
} from "./slack.js";
import {
  exchangeVercelCode,
  getVercelAccount,
  getVercelConfiguration,
  listVercelProjects,
  vercelInstallUrl,
} from "./vercel.js";

describe("integration providers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("captures the Datadog datacenter and regional MCP URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          data: {
            id: "user-1",
            attributes: {
              handle: "operator@example.com",
              name: "Operator",
              service_account: false,
            },
            relationships: {
              org: { data: { id: "org-1" } },
            },
          },
          included: [
            {
              id: "org-1",
              type: "orgs",
              attributes: { name: "Example EU" },
            },
          ],
        }),
      ),
    );

    const account = await datadogAccount({
      apiKey: "api-key",
      applicationKey: "application-key",
      site: getDatadogSite("datadoghq.eu"),
    });

    expect(account.metadata).toMatchObject({
      datacenter: "EU1",
      mcpUrl: "https://mcp.datadoghq.eu/v1/mcp",
      site: "datadoghq.eu",
      siteName: "EU1",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.datadoghq.eu/api/v2/current_user",
      expect.objectContaining({
        headers: expect.objectContaining({
          "dd-api-key": "api-key",
          "dd-application-key": "application-key",
        }),
      }),
    );
  });

  it("validates an Upstash account with email and developer API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json([
        { database_id: "db-1", database_name: "production-cache" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      upstashAccount({
        apiKey: "developer-api-key",
        email: " Operator@Example.com ",
      }),
    ).resolves.toEqual({
      displayName: "operator@example.com",
      externalAccountId: "operator@example.com",
      metadata: { databaseCount: 1 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.upstash.com/v2/redis/databases",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: `Basic ${Buffer.from(
            "operator@example.com:developer-api-key",
          ).toString("base64")}`,
        }),
      }),
    );
  });

  it("rejects invalid Upstash credentials without echoing the API key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );

    await expect(
      upstashAccount({
        apiKey: "rejected-developer-api-key",
        email: "operator@example.com",
      }),
    ).rejects.toThrow("Upstash rejected the account email or API key");
  });

  it("validates Langfuse project keys and captures project identity", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: [
          {
            id: "project-1",
            name: "Production",
            organization: { id: "org-1", name: "Example" },
          },
        ],
      }),
    );
    const verifyMcp = vi.fn().mockResolvedValue(undefined);

    await expect(
      langfuseProject(
        {
          baseUrl: "https://cloud.langfuse.com/",
          publicKey: "pk-lf-public",
          secretKey: "sk-lf-secret",
        },
        { fetch: fetchMock, verifyMcp },
      ),
    ).resolves.toEqual({
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
    expect(verifyMcp).toHaveBeenCalledWith({
      baseUrl: "https://cloud.langfuse.com",
      publicKey: "pk-lf-public",
      secretKey: "sk-lf-secret",
    });
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get("authorization"))
      .toBe(
        `Basic ${Buffer.from("pk-lf-public:sk-lf-secret").toString("base64")}`,
      );
  });

  it("rejects invalid Langfuse project keys without echoing the secret", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 401 }),
    );

    await expect(
      langfuseProject(
        {
          baseUrl: "https://cloud.langfuse.com",
          publicKey: "pk-lf-rejected",
          secretKey: "sk-lf-rejected-secret",
        },
        { fetch: fetchMock, verifyMcp: vi.fn() },
      ),
    ).rejects.toThrow("Langfuse rejected the project public key or secret key");
  });

  it("validates ClickStack access through the deployment team API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ data: { id: "team-1", name: "Production" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(
      clickStackAccount({
        accessKey: "personal-access-key",
        mcpUrl: "https://clickstack.example.com/api/mcp",
      }, fetchMock),
    ).resolves.toEqual({
      displayName: "Production",
      externalAccountId: "https://clickstack.example.com:team-1",
      mcpUrl: "https://clickstack.example.com/api/mcp",
      teamId: "team-1",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://clickstack.example.com/api/api/v2/team",
      expect.objectContaining({ redirect: "manual" }),
    );
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(requestInit.headers).get("authorization")).toBe(
      "Bearer personal-access-key",
    );
    expect(infoLog).toHaveBeenCalledWith(
      JSON.stringify({
        event: "clickstack_team_validated",
        mcpUrl: "https://clickstack.example.com/api/mcp",
        teamId: "team-1",
      }),
    );
  });

  it("logs ClickStack team lookup failures without credentials", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 503 }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      clickStackAccount({
        accessKey: "personal-access-key",
        mcpUrl: "https://clickstack.example.com/api/mcp/",
      }, fetchMock),
    ).rejects.toThrow("Unable to load the ClickStack team");
    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({
        event: "clickstack_team_lookup_failed",
        mcpUrl: "https://clickstack.example.com/api/mcp",
        status: 503,
      }),
    );
    expect(errorLog.mock.calls.flat().join(" ")).not.toContain(
      "personal-access-key",
    );
  });

  it("logs rejected ClickStack credentials without the access key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 401 }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      clickStackAccount({
        accessKey: "rejected-access-key",
        mcpUrl: "https://clickstack.example.com/api/mcp",
      }, fetchMock),
    ).rejects.toThrow("ClickStack rejected the Personal API Access Key");
    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({
        event: "clickstack_credentials_rejected",
        mcpUrl: "https://clickstack.example.com/api/mcp",
        status: 401,
      }),
    );
    expect(errorLog.mock.calls.flat().join(" ")).not.toContain(
      "rejected-access-key",
    );
  });

  it("logs ClickStack Cloud client registration failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      registerClickStackCloudClient(
        "https://responder.example/api/integrations/clickstack/callback",
      ),
    ).rejects.toThrow("ClickStack client registration failed");
    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({
        event: "clickstack_cloud_client_registration_failed",
        isRedirectResponse: false,
        redirectUri:
          "https://responder.example/api/integrations/clickstack/callback",
        status: 503,
      }),
    );
  });

  it("logs ClickStack Cloud token exchange failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ error: "invalid_grant" }, { status: 503 }),
      ),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      exchangeClickStackCloudCode({
        clientId: "dynamic-client-id",
        code: "authorization-code",
        codeVerifier: "pkce-verifier",
        redirectUri:
          "https://responder.example/api/integrations/clickstack/callback",
      }),
    ).rejects.toThrow("ClickStack authorization failed");
    expect(errorLog).toHaveBeenCalledWith(
      JSON.stringify({
        event: "clickstack_cloud_token_exchange_failed",
        oauthError: "invalid_grant",
        status: 503,
      }),
    );
  });

  it("builds a tenant-correlated Slack OAuth URL", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.stubEnv("SLACK_CLIENT_ID", "slack-client");
    vi.stubEnv("SLACK_CLIENT_SECRET", "slack-secret");

    const url = new URL(slackAuthorizeUrl("state-token"));

    expect(url.origin + url.pathname).toBe(
      "https://slack.com/oauth/v2/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("slack-client");
    expect(url.searchParams.get("state")).toBe("state-token");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://responder.example/api/integrations/slack/callback",
    );
    const scopes = url.searchParams.get("scope")?.split(",") ?? [];
    expect(scopes).toContain("app_mentions:read");
    expect(scopes).toContain("channels:join");
    expect(scopes).toContain("chat:write");
    expect(scopes).toContain("chat:write.public");
    const userScopes = url.searchParams.get("user_scope")?.split(",") ?? [];
    expect(userScopes).toEqual(
      expect.arrayContaining(["channels:history", "groups:history"]),
    );
  });

  it("joins a selected public Slack channel", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await joinSlackChannel("xoxb-token", "C123");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/conversations.join",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ channel: "C123" }),
      }),
    );
  });

  it("captures the Slack user token used by the hosted MCP", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.stubEnv("SLACK_CLIENT_ID", "slack-client");
    vi.stubEnv("SLACK_CLIENT_SECRET", "slack-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          ok: true,
          access_token: "xoxb-bot-token",
          token_type: "bot",
          scope: "channels:read",
          bot_user_id: "U-BOT",
          app_id: "A123",
          team: { id: "T123", name: "Example" },
          authed_user: {
            id: "U123",
            access_token: "xoxp-user-token",
            token_type: "user",
            scope: "channels:history,groups:history",
          },
        }),
      ),
    );

    await expect(exchangeSlackCode("one-time-code")).resolves.toMatchObject({
      access_token: "xoxb-bot-token",
      authed_user: {
        access_token: "xoxp-user-token",
        scope: "channels:history,groups:history",
      },
    });
  });

  it("asks for Slack reconnection when auto-join scope is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ ok: false, error: "missing_scope" }),
      ),
    );

    await expect(joinSlackChannel("xoxb-token", "C123")).rejects.toEqual(
      expect.objectContaining<Partial<SlackChannelJoinError>>({
        slackCode: "missing_scope",
      }),
    );
  });

  it("builds a tenant-correlated GitHub App authorization URL", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    vi.stubEnv("GITHUB_APP_ID", "123");
    vi.stubEnv("GITHUB_APP_SLUG", "responder-test");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "private-key");
    vi.stubEnv("GITHUB_CLIENT_ID", "github-client");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "github-secret");

    const url = new URL(githubAuthorizeUrl("state-token"));

    expect(url.origin + url.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("github-client");
    expect(url.searchParams.get("state")).toBe("state-token");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://responder.example/api/integrations/github/callback",
    );
  });

  it("preserves state through GitHub App installation", () => {
    vi.stubEnv("GITHUB_APP_ID", "123");
    vi.stubEnv("GITHUB_APP_SLUG", "responder-test");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "private-key");
    vi.stubEnv("GITHUB_CLIENT_ID", "github-client");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "github-secret");

    const url = new URL(githubInstallUrl("state-token"));

    expect(url.origin + url.pathname).toBe(
      "https://github.com/apps/responder-test/installations/new",
    );
    expect(url.searchParams.get("state")).toBe("state-token");
  });

  it("preserves GitHub's safe OAuth error code", async () => {
    vi.stubEnv("GITHUB_APP_ID", "123");
    vi.stubEnv("GITHUB_APP_SLUG", "responder-test");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "private-key");
    vi.stubEnv("GITHUB_CLIENT_ID", "github-client");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "github-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          error: "incorrect_client_credentials",
          error_description: "Sensitive provider detail is discarded",
        }),
      ),
    );

    await expect(exchangeGitHubCode("one-time-code", "")).rejects.toEqual(
      expect.objectContaining<Partial<GitHubOAuthError>>({
        githubCode: "incorrect_client_credentials",
        message:
          "GitHub OAuth token exchange failed: incorrect_client_credentials",
      }),
    );
  });

  it("preserves state through Sentry App installation", () => {
    vi.stubEnv("SENTRY_APP_SLUG", "responder-test");
    vi.stubEnv("SENTRY_CLIENT_ID", "sentry-client");
    vi.stubEnv("SENTRY_CLIENT_SECRET", "sentry-secret");

    const url = new URL(sentryInstallUrl("state-token"));

    expect(url.origin + url.pathname).toBe(
      "https://sentry.io/sentry-apps/responder-test/external-install/",
    );
    expect(url.searchParams.get("state")).toBe("state-token");
  });

  it("recovers an existing Sentry installation with a client-secret JWT", async () => {
    vi.stubEnv("SENTRY_APP_SLUG", "responder-test");
    vi.stubEnv("SENTRY_CLIENT_ID", "sentry-client");
    vi.stubEnv("SENTRY_CLIENT_SECRET", "sentry-secret");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({
          id: "1",
          token: "fresh-token",
          refreshToken: "fresh-refresh-token",
          expiresAt: "2026-09-01T12:00:00Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      refreshSentryGrant({
        installationId: "40000000-0000-4000-8000-000000000000",
        refreshToken: "revoked-refresh-token",
      }),
    ).resolves.toMatchObject({ token: "fresh-token" });

    const [, manualRequest] = fetchMock.mock.calls;
    const jwt = (manualRequest[1].headers.authorization as string).slice(7);
    const [encodedHeader, encodedPayload, encodedSignature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(encodedHeader, "base64url").toString())).toEqual({
      alg: "HS256",
      typ: "JWT",
    });
    const jwtPayload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString(),
    );
    expect(jwtPayload).toEqual(
      expect.objectContaining({
        exp: expect.any(Number),
        iat: expect.any(Number),
        iss: "sentry-client",
        jti: expect.any(String),
      }),
    );
    expect(jwtPayload.exp - jwtPayload.iat).toBe(60);
    expect(encodedSignature).toBe(
      createHmac("sha256", "sentry-secret")
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest("base64url"),
    );
    expect(JSON.parse(manualRequest[1].body as string)).toEqual({
      grant_type: "urn:sentry:params:oauth:grant-type:jwt-bearer",
    });
  });

  it("follows trusted regional Sentry project pagination", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          [{ id: "1", slug: "example", name: "Example" }],
          {
            headers: {
              link: '<https://de.sentry.io/api/0/organizations/example/projects/?cursor=next>; rel="next"; results="true"',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        Response.json([{ id: "2", slug: "responder", name: "Responder" }]),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listSentryProjects("token", "example")).resolves.toEqual([
      expect.objectContaining({ externalId: "1", displayName: "Example" }),
      expect.objectContaining({ externalId: "2", displayName: "Responder" }),
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://de.sentry.io/api/0/organizations/example/projects/?cursor=next",
      expect.any(Object),
    );
  });

  it("reports missing provider app configuration", () => {
    const slack = getIntegrationDefinition("slack");
    expect(slack).toBeDefined();
    expect(integrationIsConfigured(slack!)).toBe(false);

    for (const key of slack!.requiredEnvironment) {
      vi.stubEnv(key, "configured");
    }
    expect(integrationIsConfigured(slack!)).toBe(true);
  });

  it("builds a tenant-correlated Vercel installation URL", () => {
    vi.stubEnv("VERCEL_INTEGRATION_SLUG", "responder");
    vi.stubEnv("VERCEL_CLIENT_ID", "vercel-client");
    vi.stubEnv("VERCEL_CLIENT_SECRET", "vercel-secret");

    const url = new URL(vercelInstallUrl("state-token"));

    expect(url.origin + url.pathname).toBe(
      "https://vercel.com/integrations/responder/new",
    );
    expect(url.searchParams.get("state")).toBe("state-token");
  });

  it("exchanges a Vercel installation code without exposing credentials", async () => {
    vi.stubEnv("VERCEL_INTEGRATION_SLUG", "responder");
    vi.stubEnv("VERCEL_CLIENT_ID", "vercel-client");
    vi.stubEnv("VERCEL_CLIENT_SECRET", "vercel-secret");
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        access_token: "vercel-access-token",
        team_id: "team-1",
        user_id: "user-1",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      exchangeVercelCode({
        code: "one-time-code",
        redirectUri: "https://responder.example/api/integrations/vercel/callback",
      }),
    ).resolves.toMatchObject({
      access_token: "vercel-access-token",
      team_id: "team-1",
    });
    const request = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(request[0]).toBe("https://api.vercel.com/v2/oauth/access_token");
    expect(String(request[1].body)).toContain("client_id=vercel-client");
    expect(String(request[1].body)).toContain("client_secret=vercel-secret");
  });

  it("loads the Vercel team and all accessible projects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ id: "team-1", name: "Acme", slug: "acme" }),
      )
      .mockResolvedValueOnce(
        Response.json({
          projects: [{ id: "prj-1", name: "web", framework: "nextjs" }],
          pagination: { next: 123 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          projects: [{ id: "prj-2", name: "api", framework: null }],
          pagination: { next: null },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getVercelAccount({ accessToken: "token", teamId: "team-1" }),
    ).resolves.toMatchObject({
      displayName: "Acme",
      externalAccountId: "team-1",
      metadata: { scope: "team", teamId: "team-1", teamSlug: "acme" },
    });
    await expect(
      listVercelProjects({ accessToken: "token", teamId: "team-1" }),
    ).resolves.toEqual([
      expect.objectContaining({ externalId: "prj-1", displayName: "web" }),
      expect.objectContaining({ externalId: "prj-2", displayName: "api" }),
    ]);
    const secondProjectUrl = new URL(fetchMock.mock.calls[2]![0] as URL);
    expect(secondProjectUrl.searchParams.get("teamId")).toBe("team-1");
    expect(secondProjectUrl.searchParams.get("until")).toBe("123");
  });

  it("verifies a Vercel installation identity and selected projects", async () => {
    vi.stubEnv("VERCEL_INTEGRATION_SLUG", "responder");
    vi.stubEnv("VERCEL_CLIENT_ID", "vercel-client");
    vi.stubEnv("VERCEL_CLIENT_SECRET", "vercel-secret");
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        id: "icfg_1",
        projectSelection: "selected",
        projects: ["prj-1"],
        scopes: ["read:deployment", "read:logs", "read:project"],
        slug: "responder",
        status: "ready",
        teamId: "team-1",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getVercelConfiguration({
        accessToken: "token",
        configurationId: "icfg_1",
        teamId: "team-1",
      }),
    ).resolves.toMatchObject({
      id: "icfg_1",
      projects: ["prj-1"],
      scopes: ["read:deployment", "read:logs", "read:project"],
    });
    const requestUrl = new URL(fetchMock.mock.calls[0]![0] as URL);
    expect(requestUrl.pathname).toBe("/v1/integrations/configuration/icfg_1");
    expect(requestUrl.searchParams.get("teamId")).toBe("team-1");
  });

  it("connects project-scoped Vercel installations without Team read access", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: { code: "forbidden" } }, { status: 403 }))
      .mockResolvedValueOnce(
        Response.json({
          projects: [{ id: "prj-1", name: "web", framework: "nextjs" }],
          pagination: { next: null },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getVercelAccount({ accessToken: "token", teamId: "team-1" }),
    ).resolves.toEqual({
      displayName: "Vercel team",
      externalAccountId: "team-1",
      metadata: { scope: "team", teamId: "team-1" },
    });
    await expect(
      listVercelProjects({ accessToken: "token", teamId: "team-1" }),
    ).resolves.toEqual([
      expect.objectContaining({ externalId: "prj-1", displayName: "web" }),
    ]);
  });

  it("does not require an unused webhook secret for GitHub setup", () => {
    const github = getIntegrationDefinition("github");
    expect(github).toBeDefined();
    expect(github!.requiredEnvironment).not.toContain("GITHUB_WEBHOOK_SECRET");

    for (const key of github!.requiredEnvironment) {
      vi.stubEnv(key, "configured");
    }

    expect(integrationIsConfigured(github!)).toBe(true);
  });
});
