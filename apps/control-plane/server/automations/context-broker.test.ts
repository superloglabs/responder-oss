import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import { createAutomationContextBrokerRoutes } from "./context-broker.js";

const accountId = "61616161-6161-4161-8161-616161616161";

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
    providerFetch: vi.fn(),
    refreshCustomMcp: vi.fn().mockResolvedValue({
      tokens: { access_token: "fresh-oauth-token", refresh_token: "refresh-token" },
    }),
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
          arguments: { channel_id: "C123", query: "deploy failed" },
          name: "slack_search_channel",
        },
      }),
    );
    expect(call.status).toBe(200);
    expect(dependencies.slack.search).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: "xoxp-worker-only",
      channel: { id: "C123", name: "incidents" },
      signal: expect.any(AbortSignal),
    }));
    expect(await call.text()).not.toContain("xoxp-worker-only");
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
});
