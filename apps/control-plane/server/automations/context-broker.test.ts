import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import { createAutomationContextBrokerRoutes } from "./context-broker.js";
import { selfHostedGrafanaAnswer } from "./grafana-context.js";

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
    aws: {
      credentials: vi.fn(() => async () => ({
        accessKeyId: "AKIATESTACCESSKEY",
        expiration: new Date(Date.now() + 3_600_000),
        secretAccessKey: "aws-secret-access-key",
        sessionToken: "aws-session-token",
      })),
      fetch: vi.fn(),
      now: () => Date.now(),
    },
    cloudflare: { now: () => Date.now() },
    gcp: {
      authHeaders: vi.fn(async () => new Headers({
        authorization: "Bearer google-federated-token",
        "x-goog-user-project": "konex-prod",
      })),
      now: () => Date.now(),
    },
    grafana: {
      connect: vi.fn(),
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

function awsClaim(externalIdSuffix: string) {
  return claim("aws", {
    accountId: "123456789012",
    externalId: `responder_${externalIdSuffix.padEnd(40, "x")}`,
    roleArn: "arn:aws:iam::123456789012:role/ResponderInvestigationRole",
  });
}

// The managed AWS MCP server marks some tools read-only. The script runner is
// unmarked but allowed, because the read-only role limits it.
function fakeAwsMcp() {
  return vi.fn(async (_url: string | URL, init: RequestInit) => {
    const body = JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) as { id?: string; method: string };
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    const result = body.method === "initialize"
      ? { capabilities: { tools: {} }, protocolVersion: "2025-06-18" }
      : body.method === "tools/list"
        ? {
            tools: [
              { annotations: { readOnlyHint: true }, name: "aws___search_documentation" },
              { name: "aws___run_script" },
              { annotations: { readOnlyHint: false }, name: "aws___get_tasks" },
              { annotations: { readOnlyHint: false }, name: "aws___call_aws" },
              { name: "aws___get_presigned_url" },
            ],
          }
        : { content: [{ text: "queue depth 42", type: "text" }] };
    return Response.json(
      { id: body.id, jsonrpc: "2.0", result },
      { headers: body.method === "initialize" ? { "mcp-session-id": "aws-session" } : {} },
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

  describe("AWS", () => {
    const awsEndpoint = "https://aws-mcp.us-east-1.api.aws/mcp";
    const signature = /^AWS4-HMAC-SHA256 Credential=AKIATESTACCESSKEY\/\d{8}\/us-east-1\/aws-mcp\/aws4_request, /u;

    it("lists only the tools investigations allow, signed with the role session", async () => {
      vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
      const { app, dependencies } = appFor(awsClaim("list"));
      dependencies.aws.fetch.mockImplementation(fakeAwsMcp());

      const response = await app.request(
        `/api/automation-context-broker/v1/${accountId}`,
        rpcRequest({ id: 7, jsonrpc: "2.0", method: "tools/list" }),
      );

      expect(response.status).toBe(200);
      const body = await response.json() as { id: number; result: { tools: Array<{ name: string }> } };
      expect(body.id).toBe(7);
      expect(body.result.tools.map((tool) => tool.name)).toEqual([
        "aws___search_documentation",
        "aws___run_script",
        "aws___get_tasks",
      ]);
      expect(dependencies.aws.credentials).toHaveBeenCalledWith(accountId, expect.objectContaining({
        roleArn: "arn:aws:iam::123456789012:role/ResponderInvestigationRole",
      }));
      const calls = dependencies.aws.fetch.mock.calls as Array<[URL, RequestInit]>;
      expect(calls.length).toBeGreaterThan(0);
      for (const [url, init] of calls) {
        expect(url.toString()).toBe(awsEndpoint);
        expect(new Headers(init.headers).get("authorization")).toMatch(signature);
        expect(new Headers(init.headers).get("x-amz-security-token")).toBe("aws-session-token");
      }
      expect(new Headers(calls.at(-1)![1].headers).get("mcp-session-id")).toBe("aws-session");
      expect(JSON.stringify(body)).not.toContain("aws-session-token");
    });

    it("refuses tools investigations do not allow without calling AWS", async () => {
      vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
      const { app, dependencies } = appFor(awsClaim("refuse"));
      dependencies.aws.fetch.mockImplementation(fakeAwsMcp());

      for (const name of ["aws___call_aws", "aws___get_presigned_url", "not_a_tool"]) {
        const response = await app.request(
          `/api/automation-context-broker/v1/${accountId}`,
          rpcRequest({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name } }),
        );
        expect(response.status).toBe(400);
      }
      const calls = dependencies.aws.fetch.mock.calls as Array<[URL, RequestInit]>;
      expect(calls.some(([, init]) =>
        new TextDecoder().decode(init.body as Uint8Array).includes("tools/call"))).toBe(false);
    });

    it("forwards allowed tool calls signed with the role session", async () => {
      vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
      const { app, dependencies } = appFor(awsClaim("forward"));
      dependencies.aws.fetch.mockImplementation(fakeAwsMcp());

      const response = await app.request(
        `/api/automation-context-broker/v1/${accountId}`,
        {
          ...rpcRequest({
            id: 3,
            jsonrpc: "2.0",
            method: "tools/call",
            params: { arguments: { script: "print(1)" }, name: "aws___run_script" },
          }),
          headers: {
            ...rpcRequest({}).headers,
            accept: "application/json, text/event-stream",
            "mcp-session-id": "run-session",
          },
        },
      );

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("queue depth 42");
      expect(text).not.toContain("aws-session-token");
      const [url, init] = (dependencies.aws.fetch.mock.calls as Array<[URL, RequestInit]>).at(-1)!;
      expect(url.toString()).toBe(awsEndpoint);
      expect(new TextDecoder().decode(init.body as Uint8Array)).toContain("aws___run_script");
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toMatch(signature);
      expect(headers.get("mcp-session-id")).toBe("run-session");
    });

    it("rejects service paths and methods outside the tool surface", async () => {
      vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
      const { app, dependencies } = appFor(awsClaim("reject"));
      dependencies.aws.fetch.mockImplementation(fakeAwsMcp());

      const servicePath = await app.request(
        `/api/automation-context-broker/v1/${accountId}/logging`,
        rpcRequest({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      );
      const resources = await app.request(
        `/api/automation-context-broker/v1/${accountId}`,
        rpcRequest({ id: 1, jsonrpc: "2.0", method: "resources/list" }),
      );

      expect(servicePath.status).toBe(404);
      expect(resources.status).toBe(404);
      expect(dependencies.aws.fetch).not.toHaveBeenCalled();
    });
  });

  describe("Cloudflare", () => {
    beforeEach(() => {
      vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
    });

    const cloudflareTools = [
      { annotations: { readOnlyHint: false }, inputSchema: { type: "object" }, name: "search" },
      { annotations: { destructiveHint: true }, inputSchema: { type: "object" }, name: "execute" },
      { annotations: { readOnlyHint: false }, inputSchema: { type: "object" }, name: "docs" },
      { annotations: { readOnlyHint: true }, inputSchema: { type: "object" }, name: "whoami" },
      { annotations: { readOnlyHint: true }, inputSchema: { type: "object" }, name: "get_workers_scripts" },
    ];

    function cloudflareClaim() {
      return claim("cloudflare", {
        authType: "oauth",
        mcpUrl: "https://mcp.cloudflare.com/mcp",
        oauth: {
          tokens: {
            access_token: "expired-cloudflare-token",
            refresh_token: "cloudflare-refresh-token",
            scope: "user:read account:read offline_access workers-observability.read",
          },
        },
      });
    }

    function fakeCloudflareMcp() {
      return vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { id?: string; method: string };
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        const result = body.method === "initialize"
          ? { capabilities: { tools: {} }, protocolVersion: "2025-06-18" }
          : body.method === "tools/list"
            ? { tools: cloudflareTools }
            : { content: [{ text: "[{\"message\":\"checkout failed\"}]", type: "text" }] };
        return Response.json({ id: body.id, jsonrpc: "2.0", result });
      });
    }

    it("serves the API, docs, and identity tools with a refreshed read-only token", async () => {
      const { app, dependencies } = appFor(cloudflareClaim());
      dependencies.providerFetch.mockImplementation(fakeCloudflareMcp());
      dependencies.refreshCustomMcp.mockResolvedValue({
        tokens: {
          access_token: "fresh-cloudflare-token",
          refresh_token: "refresh-token",
          scope: "user:read account:read offline_access workers-observability.read",
        },
      });

      const listed = await app.request(
        `/api/automation-context-broker/v1/${accountId}`,
        rpcRequest({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      );
      expect(listed.status).toBe(200);
      const body = await listed.json() as { result: { tools: Array<{ name: string }> } };
      expect(body.result.tools.map((tool) => tool.name)).toEqual([
        "search",
        "execute",
        "docs",
        "whoami",
      ]);

      const refused = await app.request(
        `/api/automation-context-broker/v1/${accountId}`,
        rpcRequest({
          id: 2,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: {}, name: "get_workers_scripts" },
        }),
      );
      expect(refused.status).toBe(400);

      const forwarded = await app.request(
        `/api/automation-context-broker/v1/${accountId}`,
        rpcRequest({
          id: 3,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: { account_id: "a1", code: "async () => 1" }, name: "execute" },
        }),
      );
      expect(forwarded.status).toBe(200);
      expect(await forwarded.text()).toContain("checkout failed");
      const calls = dependencies.providerFetch.mock.calls as Array<[string, RequestInit]>;
      expect(calls.every(([url]) => url === "https://mcp.cloudflare.com/mcp")).toBe(true);
      expect(new Headers(calls.at(-1)![1].headers).get("authorization")).toBe("Bearer fresh-cloudflare-token");
      expect(dependencies.refreshCustomMcp).toHaveBeenCalledWith(expect.objectContaining({
        redirectUrl: expect.stringMatching(/\/api\/integrations\/cloudflare\/callback$/u),
      }));
    });

    it("refuses calls when the grant can change resources", async () => {
      const { app, dependencies } = appFor(cloudflareClaim());
      dependencies.providerFetch.mockImplementation(fakeCloudflareMcp());
      dependencies.refreshCustomMcp.mockResolvedValue({
        tokens: {
          access_token: "fresh-cloudflare-token",
          refresh_token: "refresh-token",
          scope: "user:read account:read workers-scripts.write",
        },
      });

      const response = await app.request(
        `/api/automation-context-broker/v1/${accountId}`,
        rpcRequest({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: { code: "async () => 1" }, name: "execute" },
        }),
      );

      expect(response.status).toBe(502);
      const calls = dependencies.providerFetch.mock.calls as Array<[string, RequestInit]>;
      expect(calls.some(([, init]) => String(init.body).includes("tools/call"))).toBe(false);
    });
  });

  describe("Grafana", () => {
    beforeEach(() => {
      vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
    });

    const grafanaTools = [
      { annotations: { readOnlyHint: true }, inputSchema: { type: "object" }, name: "query_prometheus" },
      { annotations: { readOnlyHint: false }, inputSchema: { type: "object" }, name: "update_dashboard" },
      { inputSchema: { type: "object" }, name: "create_incident" },
    ];

    function cloudClaim(stack: string) {
      return claim("grafana", {
        authType: "oauth",
        mcpUrl: `https://mcp.grafana.com/mcp/${stack}.grafana.net`,
        oauth: {
          tokens: {
            access_token: "expired-grafana-token",
            refresh_token: "grafana-refresh-token",
          },
        },
        stackUrl: `https://${stack}.grafana.net`,
      });
    }

    function fakeGrafanaCloudMcp() {
      return vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { id?: string; method: string };
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        const result = body.method === "initialize"
          ? { capabilities: { tools: {} }, protocolVersion: "2025-06-18" }
          : body.method === "tools/list"
            ? { tools: grafanaTools }
            : { content: [{ text: "p99 412ms", type: "text" }] };
        return Response.json(
          { id: body.id, jsonrpc: "2.0", result },
          { headers: body.method === "initialize" ? { "mcp-session-id": "grafana-session" } : {} },
        );
      });
    }

    function selfHostedClaim(host: string) {
      return claim("grafana", {
        authType: "service_account",
        grafanaUrl: `https://${host}`,
        serviceAccountToken: "glsa_worker_only",
      });
    }

    function fakeMcpGrafana() {
      return {
        callTool: vi.fn().mockResolvedValue({ content: [{ text: "3 firing alerts", type: "text" }] }),
        close: vi.fn().mockResolvedValue(undefined),
        listTools: vi.fn().mockResolvedValue({ tools: grafanaTools }),
      };
    }

    it("lists only read-only Grafana Cloud tools with a refreshed token", async () => {
      const { app, dependencies } = appFor(cloudClaim("list-acme"));
      dependencies.providerFetch.mockImplementation(fakeGrafanaCloudMcp());

      const response = await app.request(
        `/api/automation-context-broker/v1/${accountId}`,
        rpcRequest({ id: 4, jsonrpc: "2.0", method: "tools/list" }),
      );

      expect(response.status).toBe(200);
      const body = await response.json() as { result: { tools: Array<{ name: string }> } };
      expect(body.result.tools.map((tool) => tool.name)).toEqual(["query_prometheus"]);
      expect(dependencies.refreshCustomMcp).toHaveBeenCalledWith(expect.objectContaining({
        mcpUrl: "https://mcp.grafana.com/mcp/list-acme.grafana.net",
      }));
      const calls = dependencies.providerFetch.mock.calls as Array<[string, RequestInit]>;
      expect(calls.every(([url]) => url === "https://mcp.grafana.com/mcp/list-acme.grafana.net")).toBe(true);
      expect(new Headers(calls.at(-1)![1].headers).get("authorization")).toBe("Bearer fresh-oauth-token");
      expect(JSON.stringify(body)).not.toContain("fresh-oauth-token");
    });

    it("refuses Grafana Cloud tools that are not read-only and forwards the rest", async () => {
      const { app, dependencies } = appFor(cloudClaim("call-acme"));
      dependencies.providerFetch.mockImplementation(fakeGrafanaCloudMcp());

      for (const name of ["update_dashboard", "create_incident"]) {
        const refused = await app.request(
          `/api/automation-context-broker/v1/${accountId}`,
          rpcRequest({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name } }),
        );
        expect(refused.status).toBe(400);
      }
      const calls = dependencies.providerFetch.mock.calls as Array<[string, RequestInit]>;
      expect(calls.some(([, init]) => String(init.body).includes("tools/call"))).toBe(false);

      const forwarded = await app.request(
        `/api/automation-context-broker/v1/${accountId}`,
        rpcRequest({
          id: 2,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: { expr: "up" }, name: "query_prometheus" },
        }),
      );
      expect(forwarded.status).toBe(200);
      expect(await forwarded.text()).toContain("p99 412ms");
      const [, init] = (dependencies.providerFetch.mock.calls as Array<[string, RequestInit]>).at(-1)!;
      expect(String(init.body)).toContain("query_prometheus");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fresh-oauth-token");
    });

    it("serves self-hosted Grafana's read-only tools without exposing the token", async () => {
      const { app, dependencies } = appFor(selfHostedClaim("list.grafana.example.com"));
      const client = fakeMcpGrafana();
      dependencies.grafana.connect.mockResolvedValue(client);

      const initialize = await app.request(
        `/api/automation-context-broker/v1/${accountId}`,
        rpcRequest({ id: 1, jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-06-18" } }),
      );
      expect(await initialize.json()).toMatchObject({
        id: 1,
        result: { protocolVersion: "2025-06-18", serverInfo: { name: "responder-grafana" } },
      });
      expect(dependencies.grafana.connect).not.toHaveBeenCalled();

      const list = await app.request(
        `/api/automation-context-broker/v1/${accountId}`,
        rpcRequest({ id: 2, jsonrpc: "2.0", method: "tools/list" }),
      );
      const listBody = await list.json() as { id: number; result: { tools: Array<{ name: string }> } };
      expect(listBody.id).toBe(2);
      expect(listBody.result.tools.map((tool) => tool.name)).toEqual(["query_prometheus"]);
      expect(dependencies.grafana.connect).toHaveBeenCalledWith(
        { authType: "service_account", grafanaUrl: "https://list.grafana.example.com", serviceAccountToken: "glsa_worker_only" },
        expect.any(AbortSignal),
      );
      expect(client.close).toHaveBeenCalled();
      expect(JSON.stringify(listBody)).not.toContain("glsa_worker_only");
    });

    it("starts mcp-grafana once for a call that finds no cached listing", async () => {
      const { app, dependencies } = appFor(selfHostedClaim("cold.grafana.example.com"));
      const client = fakeMcpGrafana();
      dependencies.grafana.connect.mockResolvedValue(client);

      const call = await app.request(
        `/api/automation-context-broker/v1/${accountId}`,
        rpcRequest({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: {}, name: "query_prometheus" },
        }),
      );

      expect(call.status).toBe(200);
      expect(dependencies.grafana.connect).toHaveBeenCalledTimes(1);
      expect(client.listTools).toHaveBeenCalledTimes(1);
      expect(client.callTool).toHaveBeenCalledTimes(1);
      expect(client.close).toHaveBeenCalledTimes(1);
    });

    it("does not start mcp-grafana for a request that was already cancelled", async () => {
      const { dependencies } = appFor(null);
      const cancelled = new AbortController();
      cancelled.abort();

      await expect(selfHostedGrafanaAnswer({
        accountId,
        connection: { grafanaUrl: "https://cancelled.grafana.example.com", serviceAccountToken: "glsa_token" },
        dependencies: dependencies.grafana,
        method: "tools/list",
        params: {},
        signal: cancelled.signal,
      })).rejects.toThrow();
      expect(dependencies.grafana.connect).not.toHaveBeenCalled();
    });

    it("calls read-only self-hosted Grafana tools and refuses the rest", async () => {
      const { app, dependencies } = appFor(selfHostedClaim("call.grafana.example.com"));
      const client = fakeMcpGrafana();
      dependencies.grafana.connect.mockResolvedValue(client);

      for (const name of ["update_dashboard", "create_incident", "not_a_tool"]) {
        const refused = await app.request(
          `/api/automation-context-broker/v1/${accountId}`,
          rpcRequest({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name } }),
        );
        expect(refused.status).toBe(400);
      }
      expect(client.callTool).not.toHaveBeenCalled();

      const call = await app.request(
        `/api/automation-context-broker/v1/${accountId}`,
        rpcRequest({
          id: 3,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: { expr: "up" }, name: "query_prometheus" },
        }),
      );
      expect(call.status).toBe(200);
      expect(await call.json()).toEqual({
        id: 3,
        jsonrpc: "2.0",
        result: { content: [{ text: "3 firing alerts", type: "text" }] },
      });
      expect(client.callTool).toHaveBeenCalledWith(
        { arguments: { expr: "up" }, name: "query_prometheus" },
        undefined,
        expect.objectContaining({ signal: expect.any(AbortSignal), timeout: 60_000 }),
      );
      expect(client.close).toHaveBeenCalledTimes(2);

      const resources = await app.request(
        `/api/automation-context-broker/v1/${accountId}`,
        rpcRequest({ id: 4, jsonrpc: "2.0", method: "resources/list" }),
      );
      expect(resources.status).toBe(404);
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

    it("lists every Axiom tool with a refreshed token", async () => {
      const { app, dependencies } = appFor(axiomClaim());
      const result = { tools: [{ name: "queryDataset" }, { name: "createMonitor" }, { name: "deleteDashboard" }] };
      const body = `event: message\ndata: ${JSON.stringify({ id: 1, jsonrpc: "2.0", result })}\n\n`;
      dependencies.providerFetch.mockResolvedValue(new Response(
        body,
        { headers: { "content-type": "text/event-stream", "mcp-session-id": "axiom-session" } },
      ));

      const response = await app.request(
        `/api/automation-context-broker/v1/${accountId}`,
        rpcRequest({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("mcp-session-id")).toBe("axiom-session");
      expect(await response.text()).toBe(body);
      expect(dependencies.refreshCustomMcp).toHaveBeenCalledWith(expect.objectContaining({
        mcpUrl: "https://mcp.axiom.co/mcp",
      }));
      const [url, request] = dependencies.providerFetch.mock.calls[0]! as [string, RequestInit];
      expect(url).toBe("https://mcp.axiom.co/mcp");
      expect(new Headers(request.headers).get("authorization")).toBe("Bearer fresh-oauth-token");
    });

    it.each([
      ["queryDataset", { apl: "['logs'] | take 1" }],
      ["createMonitor", { name: "High error rate" }],
      ["deleteDashboard", { uid: "abc123" }],
    ])("forwards %s calls", async (name, args) => {
      const { app, dependencies } = appFor(axiomClaim());
      dependencies.providerFetch.mockResolvedValue(new Response(
        JSON.stringify({ id: 3, jsonrpc: "2.0", result: { content: [{ text: "rows", type: "text" }] } }),
        { headers: { "content-type": "application/json" } },
      ));

      const response = await app.request(
        `/api/automation-context-broker/v1/${accountId}`,
        rpcRequest({ id: 3, jsonrpc: "2.0", method: "tools/call", params: { arguments: args, name } }),
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

  it("serves the Vercel read tools scoped to the installation's projects", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      id: "prj-1",
      name: "web",
      token: "nested-token",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const vercelClaim = {
      ...claim("vercel", {
        accessToken: "vercel-installation-token",
        configurationId: "icfg_1",
        teamId: "team-1",
        userId: null,
      }),
      resources: [{ displayName: "web", externalId: "prj-1", kind: "vercel_project" }],
    };
    const { app, dependencies } = appFor(vercelClaim);
    const call = (id: number, name: string, args: unknown) => app.request(
      `/api/automation-context-broker/v1/${accountId}`,
      rpcRequest({ id, jsonrpc: "2.0", method: "tools/call", params: { arguments: args, name } }),
    );

    try {
      const list = await app.request(
        `/api/automation-context-broker/v1/${accountId}`,
        rpcRequest({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      );
      const listBody = await list.json() as { result: { tools: Array<{ annotations: { readOnlyHint: boolean }; name: string }> } };
      expect(listBody.result.tools.map((tool) => tool.name)).toEqual(["search_vercel_api", "call_vercel_api"]);
      expect(listBody.result.tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);

      const search = await call(2, "search_vercel_api", { query: "runtime logs" });
      expect(await search.text()).toContain("getRuntimeLogs");

      const project = await call(3, "call_vercel_api", {
        operationId: "getProject",
        pathParameters: [{ name: "idOrName", value: "prj-1" }],
      });
      const projectBody = await project.text();
      expect(projectBody).toContain("prj-1");
      expect(projectBody).not.toContain("nested-token");
      const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(url.toString()).toBe("https://api.vercel.com/v9/projects/prj-1?teamId=team-1");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer vercel-installation-token");

      const outside = await call(4, "call_vercel_api", {
        operationId: "getProject",
        pathParameters: [{ name: "idOrName", value: "prj-other" }],
      });
      expect(await outside.json()).toMatchObject({
        result: { isError: true, content: [{ text: expect.stringContaining("not available to this connection") }] },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const unknown = await call(5, "createDeployment", {});
      expect(unknown.status).toBe(400);
      expect(dependencies.providerFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lists no Vercel tools for a connection without credentials", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
    const vercelClaim = claim("vercel", {});
    const { app } = appFor({
      ...vercelClaim,
      account: { ...vercelClaim.account, encryptedCredentials: null },
    } as unknown as ReturnType<typeof claim>);

    const list = await app.request(
      `/api/automation-context-broker/v1/${accountId}`,
      rpcRequest({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
    );

    expect(list.status).toBe(404);
  });

  it("passes the broker request's cancellation to Vercel calls", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
    const { dependencies } = appFor(claim("vercel", {
      accessToken: "vercel-installation-token",
      configurationId: "icfg_1",
      teamId: "team-1",
      userId: null,
    }));
    const callApi = vi.fn().mockResolvedValue("{}");
    const routes = new Hono().route(
      "/api/automation-context-broker",
      createAutomationContextBrokerRoutes({ ...dependencies, vercel: { callApi } }),
    );

    await routes.request(
      `/api/automation-context-broker/v1/${accountId}`,
      rpcRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { operationId: "getProject" }, name: "call_vercel_api" },
      }),
    );

    expect(callApi).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "vercel-installation-token" }),
      expect.objectContaining({ operationId: "getProject" }),
      expect.any(AbortSignal),
    );
  });
});
