import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import { createAutomationContextBrokerRoutes } from "./context-broker.js";

const accountId = "61616161-6161-4161-8161-616161616161";

function linearCredentials(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: "linear-token",
    authType: "linear_oauth" as const,
    expiresAt: Date.now() + 3_600_000,
    mcpUrl: "https://mcp.linear.app/mcp" as const,
    refreshToken: "linear-refresh-token",
    scope: "read,write",
    tokenType: "Bearer",
    ...overrides,
  };
}

function claim(provider: string, credentials: Record<string, unknown>) {
  return {
    account: {
      encryptedCredentials: encryptCredentials(credentials),
      externalAccountId: "external-account",
      id: accountId,
      metadata: provider === "sentry"
        ? { organizationSlug: "acme" }
        : {},
      provider,
    },
    organizationId: "15151515-1515-4515-8515-151515151515",
    resources: provider === "slack"
      ? [{ displayName: "incidents", externalId: "C123", kind: "slack_channel" }]
      : [],
    roles: ["context" as const],
    runId: "21212121-2121-4121-8121-212121212121",
    trigger: {},
  };
}

function appFor(activeClaim: ReturnType<typeof claim> | null) {
  const dependencies = {
    gcp: {
      authHeaders: vi.fn(async () => new Headers({
        authorization: "Bearer google-federated-token",
        "x-goog-user-project": "konex-prod",
      })),
      now: () => Date.now(),
    },
    freshSentryCredentials: vi.fn().mockResolvedValue({
      accessToken: "fresh-sentry-token",
      expiresAt: null,
      installationId: "71717171-7171-4171-8171-717171717171",
      refreshToken: "sentry-refresh-token",
    }),
    linear: {
      appendEvent: vi.fn().mockResolvedValue(1),
      beginAttempt: vi.fn().mockResolvedValue({ id: "31313131-3131-4131-8131-313131313131", status: "started" }),
      callTool: vi.fn(),
      completeAttempt: vi.fn().mockResolvedValue(undefined),
      createIssue: vi.fn().mockResolvedValue({
        id: "31313131-3131-4131-8131-313131313131",
        identifier: "OPS-42",
        url: "https://linear.app/acme/issue/OPS-42/checkout-returns-503",
      }),
      failAttempt: vi.fn().mockResolvedValue(undefined),
      findIssue: vi.fn(),
      listTools: vi.fn().mockResolvedValue([
        { annotations: { readOnlyHint: true }, inputSchema: { type: "object" }, name: "list_users" },
      ]),
    },
    providerFetch: vi.fn(),
    refreshCustomMcp: vi.fn().mockResolvedValue({
      tokens: { access_token: "fresh-oauth-token", refresh_token: "refresh-token" },
    }),
    refreshLinear: vi.fn().mockResolvedValue(linearCredentials({
      accessToken: "fresh-linear-token",
    })),
    resolveGrant: vi.fn().mockResolvedValue(activeClaim),
    slack: {
      addReaction: vi.fn(),
      appendEvent: vi.fn(),
      beginAttempt: vi.fn(),
      completeAttempt: vi.fn(),
      failAttempt: vi.fn(),
      postMessage: vi.fn(),
      readChannel: vi.fn(),
      readThread: vi.fn(),
      removeReaction: vi.fn(),
      search: vi.fn().mockResolvedValue({
        channel: { id: "C123", name: "incidents" },
        matches: [],
        query: "deploy failed",
        totalMatches: 0,
      }),
    },
    withCredentialLease: vi.fn(async (input) => {
      if (!activeClaim?.account.encryptedCredentials) return null;
      const result = await input.operation(activeClaim.account.encryptedCredentials);
      return result.value;
    }),
  };
  const app = new Hono().route(
    "/api/automation-context-broker",
    createAutomationContextBrokerRoutes(dependencies),
  );
  return { app, dependencies };
}

function gcpClaim(sessionSuffix: string) {
  return claim("gcp", {
    projectId: "konex-prod",
    projectNumber: "123456789012",
    sessionName: `responder-gcp-${sessionSuffix.padEnd(32, "x")}`,
  });
}

// A Google MCP server that answers with server-sent events, the way
// Streamable HTTP servers may.
function fakeGoogleMcp() {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id?: string; method: string };
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    const result = body.method === "initialize"
      ? { capabilities: { tools: {} }, protocolVersion: "2025-06-18" }
      : body.method === "tools/list"
        ? {
            tools: [
              { annotations: { readOnlyHint: true }, name: "list_log_entries" },
              { annotations: { readOnlyHint: false }, name: "delete_log" },
              { name: "create_sink" },
            ],
          }
        : { content: [{ text: "entries", type: "text" }] };
    return new Response(
      `event: message\ndata: ${JSON.stringify({ id: body.id, jsonrpc: "2.0", result })}\n\n`,
      {
        headers: {
          "content-type": "text/event-stream",
          ...(body.method === "initialize" ? { "mcp-session-id": "google-session" } : {}),
        },
      },
    );
  });
}

function rpcRequest(body: unknown) {
  return {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer rmb_v1_${"a".repeat(43)}`,
      "content-type": "application/json",
    },
    method: "POST",
  };
}

describe("automation context broker", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("fails closed when the run-scoped grant cannot select the account", async () => {
    const { app } = appFor(null);
    const response = await app.request(
      `/api/automation-context-broker/v1/${accountId}`,
      rpcRequest({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
    );

    expect(response.status).toBe(401);
  });

  it("rejects unknown Slack tools", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
    const { app } = appFor(claim("slack", { accessToken: "xoxb-worker-only" }));
    const response = await app.request(
      `/api/automation-context-broker/v1/${accountId}`,
      rpcRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: {}, name: "slack_delete_channel" },
      }),
    );

    expect(response.status).toBe(400);
  });

  it("exposes scoped Slack search without returning its credential", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
    const { app, dependencies } = appFor(
      claim("slack", { userAccessToken: "xoxp-worker-only" }),
    );
    const list = await app.request(
      `/api/automation-context-broker/v1/${accountId}`,
      rpcRequest({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
    );
    const listBody = await list.text();
    expect(listBody).toContain("slack_search_channel");
    expect(listBody).toContain("slack_post_message");
    expect(listBody).toContain("C123");
    expect(listBody).not.toContain("xoxp-worker-only");

    const call = await app.request(
      `/api/automation-context-broker/v1/${accountId}`,
      rpcRequest({
        id: 2,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { channel_ids: ["C123"], query: "deploy failed" },
          name: "slack_search_channel",
        },
      }),
    );
    expect(call.status).toBe(200);
    expect(dependencies.slack.search).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: "xoxp-worker-only",
      channels: [{ id: "C123", name: "incidents" }],
      signal: expect.any(AbortSignal),
    }));
    expect(await call.text()).not.toContain("xoxp-worker-only");
  });

  describe("Google Cloud", () => {
    it("lists only the tools Google marks read-only", async () => {
      vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
      const { app, dependencies } = appFor(gcpClaim("list"));
      dependencies.providerFetch.mockImplementation(fakeGoogleMcp());

      const response = await app.request(
        `/api/automation-context-broker/v1/${accountId}/logging`,
        rpcRequest({ id: 7, jsonrpc: "2.0", method: "tools/list" }),
      );

      expect(response.status).toBe(200);
      const body = await response.json() as { id: number; result: { tools: Array<{ name: string }> } };
      expect(body.id).toBe(7);
      expect(body.result.tools.map((tool) => tool.name)).toEqual(["list_log_entries"]);
      const calls = dependencies.providerFetch.mock.calls as Array<[string, RequestInit]>;
      expect(calls.every(([url]) => url === "https://logging.googleapis.com/mcp")).toBe(true);
      const listHeaders = new Headers(calls.at(-1)![1].headers);
      expect(listHeaders.get("authorization")).toBe("Bearer google-federated-token");
      expect(listHeaders.get("mcp-session-id")).toBe("google-session");
      expect(listHeaders.get("mcp-protocol-version")).toBe("2025-06-18");
      expect(JSON.stringify(body)).not.toContain("google-federated-token");
    });

    it("refuses tools that are not read-only without calling Google", async () => {
      vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
      const { app, dependencies } = appFor(gcpClaim("refuse"));
      dependencies.providerFetch.mockImplementation(fakeGoogleMcp());

      for (const name of ["delete_log", "create_sink", "not_a_tool"]) {
        const response = await app.request(
          `/api/automation-context-broker/v1/${accountId}/logging`,
          rpcRequest({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name } }),
        );
        expect(response.status).toBe(400);
      }
      const calls = dependencies.providerFetch.mock.calls as Array<[string, RequestInit]>;
      expect(calls.some(([, init]) => String(init.body).includes("tools/call"))).toBe(false);
    });

    it("forwards read-only tool calls with the federated Google credential", async () => {
      vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
      const { app, dependencies } = appFor(gcpClaim("forward"));
      dependencies.providerFetch.mockImplementation(fakeGoogleMcp());

      const response = await app.request(
        `/api/automation-context-broker/v1/${accountId}/logging`,
        {
          ...rpcRequest({
            id: 3,
            jsonrpc: "2.0",
            method: "tools/call",
            params: { arguments: { filter: "severity>=ERROR" }, name: "list_log_entries" },
          }),
          headers: {
            ...rpcRequest({}).headers,
            accept: "application/json, text/event-stream",
            "mcp-session-id": "run-session",
          },
        },
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("entries");
      const [url, init] = (dependencies.providerFetch.mock.calls as Array<[string, RequestInit]>).at(-1)!;
      expect(url).toBe("https://logging.googleapis.com/mcp");
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer google-federated-token");
      expect(headers.get("x-goog-user-project")).toBe("konex-prod");
      expect(headers.get("mcp-session-id")).toBe("run-session");
    });

    it("rejects unknown services and methods outside the tool surface", async () => {
      vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
      const { app, dependencies } = appFor(gcpClaim("reject"));
      dependencies.providerFetch.mockImplementation(fakeGoogleMcp());

      const unknownService = await app.request(
        `/api/automation-context-broker/v1/${accountId}/storage`,
        rpcRequest({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      );
      const noService = await app.request(
        `/api/automation-context-broker/v1/${accountId}`,
        rpcRequest({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      );
      const resources = await app.request(
        `/api/automation-context-broker/v1/${accountId}/logging`,
        rpcRequest({ id: 1, jsonrpc: "2.0", method: "resources/list" }),
      );

      expect(unknownService.status).toBe(404);
      expect(noService.status).toBe(404);
      expect(resources.status).toBe(404);
      expect(dependencies.providerFetch).not.toHaveBeenCalled();
    });

    it("does not accept a service path for other providers", async () => {
      vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
      const { app, dependencies } = appFor(claim("datadog", {
        apiKey: "dd-api-secret",
        applicationKey: "dd-app-secret",
        authType: "api_keys",
      }));

      const response = await app.request(
        `/api/automation-context-broker/v1/${accountId}/logging`,
        rpcRequest({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      );

      expect(response.status).toBe(404);
      expect(dependencies.providerFetch).not.toHaveBeenCalled();
    });
  });

  it("injects Datadog credentials only into the upstream request", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
    const { app, dependencies } = appFor(claim("datadog", {
      apiKey: "dd-api-secret",
      applicationKey: "dd-app-secret",
      authType: "api_keys",
      site: "datadoghq.com",
    }));
    dependencies.providerFetch.mockResolvedValue(new Response(
      JSON.stringify({ id: 1, jsonrpc: "2.0", result: { tools: [] } }),
      { headers: { "content-type": "application/json" } },
    ));

    const response = await app.request(
      `/api/automation-context-broker/v1/${accountId}`,
      rpcRequest({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
    );

    expect(response.status).toBe(200);
    const request = dependencies.providerFetch.mock.calls[0]![1] as RequestInit;
    const headers = new Headers(request.headers);
    expect(headers.get("dd-api-key")).toBe("dd-api-secret");
    expect(headers.get("dd-application-key")).toBe("dd-app-secret");
    expect(headers.get("authorization")).toBeNull();
    expect(await response.text()).not.toContain("dd-api-secret");
  });

  it("refreshes Sentry credentials before proxying", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
    const activeClaim = claim("sentry", {
      accessToken: "expired-sentry-token",
      expiresAt: "2026-01-01T00:00:00.000Z",
      installationId: "71717171-7171-4171-8171-717171717171",
      refreshToken: "sentry-refresh-token",
    });
    const { app, dependencies } = appFor(activeClaim);
    dependencies.providerFetch.mockResolvedValue(new Response(
      JSON.stringify({ id: 1, jsonrpc: "2.0", result: { tools: [] } }),
      { headers: { "content-type": "application/json" } },
    ));

    const response = await app.request(
      `/api/automation-context-broker/v1/${accountId}`,
      rpcRequest({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
    );

    expect(response.status).toBe(200);
    expect(dependencies.freshSentryCredentials).toHaveBeenCalledWith({
      encryptedCredentials: activeClaim.account.encryptedCredentials,
      integrationAccountId: accountId,
      organizationId: activeClaim.organizationId,
    });
    expect(dependencies.providerFetch).toHaveBeenCalledWith(
      "https://mcp.sentry.dev/mcp/acme?skills=inspect",
      expect.anything(),
    );
    const request = dependencies.providerFetch.mock.calls[0]![1] as RequestInit;
    expect(new Headers(request.headers).get("authorization")).toBe(
      "Sentry-Bearer fresh-sentry-token",
    );
    expect(await response.text()).not.toContain("sentry-token");
  });

  it("refreshes custom MCP OAuth credentials before proxying", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
    const { app, dependencies } = appFor(claim("custom_mcp", {
      authType: "oauth",
      mcpUrl: "https://mcp.example.test/api",
      oauth: {
        tokens: {
          access_token: "expired-token",
          refresh_token: "refresh-token",
        },
      },
    }));
    dependencies.providerFetch.mockResolvedValue(new Response(
      JSON.stringify({ id: 1, jsonrpc: "2.0", result: { tools: [] } }),
      { headers: { "content-type": "application/json" } },
    ));

    const response = await app.request(
      `/api/automation-context-broker/v1/${accountId}`,
      rpcRequest({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
    );

    expect(response.status).toBe(200);
    expect(dependencies.refreshCustomMcp).toHaveBeenCalledOnce();
    const request = dependencies.providerFetch.mock.calls[0]![1] as RequestInit;
    expect(new Headers(request.headers).get("authorization")).toBe(
      "Bearer fresh-oauth-token",
    );
  });

  describe("Axiom", () => {
    beforeEach(() => {
      vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
    });

    function axiomClaim() {
      return claim("axiom", {
        authType: "oauth",
        mcpUrl: "https://mcp.axiom.co/mcp",
        oauth: {
          tokens: {
            access_token: "expired-axiom-token",
            refresh_token: "axiom-refresh-token",
          },
        },
      });
    }

    it("lists only read-only Axiom tools with a refreshed token", async () => {
      const { app, dependencies } = appFor(axiomClaim());
      const result = { tools: [{ name: "queryApl" }, { name: "updateMonitor" }, { name: "listDatasets" }] };
      dependencies.providerFetch.mockResolvedValue(new Response(
        `event: message\ndata: ${JSON.stringify({ id: 1, jsonrpc: "2.0", result })}\n\n`,
        { headers: { "content-type": "text/event-stream", "mcp-session-id": "axiom-session" } },
      ));

      const response = await app.request(
        `/api/automation-context-broker/v1/${accountId}`,
        rpcRequest({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("mcp-session-id")).toBe("axiom-session");
      expect(await response.json()).toEqual({
        id: 1,
        jsonrpc: "2.0",
        result: { tools: [{ name: "queryApl" }, { name: "listDatasets" }] },
      });
      expect(dependencies.refreshCustomMcp).toHaveBeenCalledWith(expect.objectContaining({
        mcpUrl: "https://mcp.axiom.co/mcp",
      }));
      const [url, request] = dependencies.providerFetch.mock.calls[0]! as [string, RequestInit];
      expect(url).toBe("https://mcp.axiom.co/mcp");
      expect(new Headers(request.headers).get("authorization")).toBe("Bearer fresh-oauth-token");
    });

    it("refuses Axiom tools outside the read-only allowlist without calling Axiom", async () => {
      const { app, dependencies } = appFor(axiomClaim());

      const response = await app.request(
        `/api/automation-context-broker/v1/${accountId}`,
        rpcRequest({ id: 2, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name: "deleteMonitor" } }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: -32602 } });
      expect(dependencies.providerFetch).not.toHaveBeenCalled();
      expect(dependencies.refreshCustomMcp).not.toHaveBeenCalled();
    });

    it("forwards read-only Axiom tool calls", async () => {
      const { app, dependencies } = appFor(axiomClaim());
      dependencies.providerFetch.mockResolvedValue(new Response(
        JSON.stringify({ id: 3, jsonrpc: "2.0", result: { content: [{ text: "rows", type: "text" }] } }),
        { headers: { "content-type": "application/json" } },
      ));

      const response = await app.request(
        `/api/automation-context-broker/v1/${accountId}`,
        rpcRequest({ id: 3, jsonrpc: "2.0", method: "tools/call", params: { arguments: { apl: "['logs'] | take 1" }, name: "queryApl" } }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ result: { content: [{ text: "rows" }] } });
    });
  });

  it("serves Linear's read tools and create_issue with a refreshed token", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
    const { app, dependencies } = appFor(claim("linear", linearCredentials({ expiresAt: Date.now() - 1 })));

    const initialize = await app.request(
      `/api/automation-context-broker/v1/${accountId}`,
      rpcRequest({ id: 1, jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    );
    expect(await initialize.json()).toMatchObject({ result: { protocolVersion: "2025-06-18" } });

    const list = await app.request(
      `/api/automation-context-broker/v1/${accountId}`,
      rpcRequest({ id: 2, jsonrpc: "2.0", method: "tools/list" }),
    );
    const listBody = await list.json() as { result: { tools: Array<{ name: string }> } };
    expect(listBody.result.tools.map((tool) => tool.name)).toEqual(["list_users", "create_issue"]);
    expect(dependencies.refreshLinear).toHaveBeenCalled();
    expect(dependencies.linear.listTools).toHaveBeenCalledWith({ accessToken: "fresh-linear-token" });

    const create = await app.request(
      `/api/automation-context-broker/v1/${accountId}`,
      rpcRequest({
        id: 3,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { assignee_id: "user-1", description: "Details", team_id: "team-ops", title: "Checkout returns 503" },
          name: "create_issue",
        },
      }),
    );
    const createBody = await create.text();
    expect(createBody).toContain("OPS-42");
    expect(createBody).not.toContain("fresh-linear-token");
    expect(dependencies.linear.createIssue).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: "fresh-linear-token",
      assigneeId: "user-1",
    }));
    expect(dependencies.providerFetch).not.toHaveBeenCalled();
  });
});
