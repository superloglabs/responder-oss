import { Hono } from "hono";
import { z } from "zod";
import {
  automationModelBrokerTokenHash,
  readAutomationModelBrokerBearerToken,
} from "../../../../packages/core/src/automations/model-broker.js";
import {
  resolveAutomationContextBrokerGrant,
  type AutomationContextBrokerClaim,
} from "../../../../packages/core/src/db/automation-model-broker.js";
import {
  decryptCredentials,
  encryptCredentials,
} from "../../../../packages/core/src/credentials/encryption.js";
import { withIntegrationAccountCredentialLease } from "../../../../packages/core/src/db/integrations.js";
import { freshSentryCredentials } from "../../../../packages/core/src/db/investigations.js";
import { awsConnectionCredentialsSchema } from "../../../../packages/core/src/integrations/aws.js";
import { parseAxiomCredentials } from "../../../../packages/core/src/integrations/axiom.js";
import { getDatadogSite } from "../../../../packages/core/src/integrations/datadog.js";
import {
  parseCustomMcpCredentials,
  refreshCustomMcpOAuth,
  safeCustomMcpFetch,
  type CustomMcpCredentials,
} from "../../../../packages/core/src/integrations/custom-mcp.js";
import { gcpConnectionCredentialsSchema } from "../../../../packages/core/src/integrations/gcp.js";
import { parseGrafanaCredentials } from "../../../../packages/core/src/integrations/grafana.js";
import {
  assertCloudflareReadOnlyGrant,
  parseCloudflareCredentials,
  withCloudflareGrantScope,
} from "../../../../packages/core/src/integrations/cloudflare.js";
import {
  linearAccessTokenNeedsRefresh,
  parseLinearOAuthCredentials,
  refreshLinearOAuthCredentials,
} from "../../../../packages/core/src/integrations/linear.js";
import { integrationCallbackUrl } from "../integrations/urls.js";
import {
  awsContextCredentials,
  awsContextFetch,
  awsContextServer,
  type AwsContextDependencies,
} from "./aws-context.js";
import { cloudflareContextServer } from "./cloudflare-context.js";
import {
  gcpAuthHeaders,
  gcpContextServer,
  type GcpContextDependencies,
  isGcpMcpService,
} from "./gcp-context.js";
import {
  defaultSelfHostedGrafanaDependencies,
  grafanaCloudContextServer,
  selfHostedGrafanaAnswer,
  type SelfHostedGrafanaDependencies,
} from "./grafana-context.js";
import { managedMcpDecision, type ManagedMcpServer } from "./managed-mcp-context.js";
import {
  callLinearTool,
  defaultLinearToolDependencies,
  linearToolDefinitions,
  type LinearToolDependencies,
} from "./linear-tools.js";
import {
  callSlackTool,
  defaultSlackToolDependencies,
  slackToolDefinitions,
  slackToolScope,
  UnknownSlackToolError,
  type SlackToolDependencies,
} from "./slack-tools.js";
import {
  callVercelTool,
  defaultVercelToolDependencies,
  vercelContextConnection,
  vercelToolDefinitions,
  type VercelToolDependencies,
} from "./vercel-context.js";

const accountIdSchema = z.uuid();
const requestSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

type ResolveGrant = typeof resolveAutomationContextBrokerGrant;

interface ContextBrokerDependencies {
  aws: AwsContextDependencies;
  cloudflare: { now: () => number };
  freshSentryCredentials: typeof freshSentryCredentials;
  gcp: Pick<GcpContextDependencies, "authHeaders" | "now">;
  grafana: SelfHostedGrafanaDependencies;
  linear: LinearToolDependencies;
  providerFetch: typeof safeCustomMcpFetch;
  refreshCustomMcp: typeof refreshCustomMcpOAuth;
  refreshLinear: typeof refreshLinearOAuthCredentials;
  resolveGrant: ResolveGrant;
  slack: SlackToolDependencies;
  vercel: VercelToolDependencies;
  withCredentialLease: typeof withIntegrationAccountCredentialLease;
}

const defaultDependencies: ContextBrokerDependencies = {
  aws: { credentials: awsContextCredentials, fetch: awsContextFetch, now: Date.now },
  cloudflare: { now: Date.now },
  freshSentryCredentials,
  gcp: { authHeaders: gcpAuthHeaders, now: Date.now },
  grafana: defaultSelfHostedGrafanaDependencies,
  linear: defaultLinearToolDependencies,
  providerFetch: safeCustomMcpFetch,
  refreshCustomMcp: refreshCustomMcpOAuth,
  refreshLinear: refreshLinearOAuthCredentials,
  resolveGrant: resolveAutomationContextBrokerGrant,
  slack: defaultSlackToolDependencies,
  vercel: defaultVercelToolDependencies,
  withCredentialLease: withIntegrationAccountCredentialLease,
};

function rpcResult(id: string | number | undefined, result: unknown) {
  return { id: id ?? null, jsonrpc: "2.0" as const, result };
}

function rpcError(
  id: string | number | undefined,
  code: number,
  message: string,
) {
  return { error: { code, message }, id: id ?? null, jsonrpc: "2.0" as const };
}

async function providerTarget(
  claim: AutomationContextBrokerClaim,
  dependencies: ContextBrokerDependencies,
): Promise<{
  headers: Headers;
  url: string;
} | null> {
  if (!claim.account.encryptedCredentials) return null;
  const credentials = decryptCredentials<Record<string, unknown>>(
    claim.account.encryptedCredentials,
  );
  if (claim.account.provider === "datadog") {
    const parsed = z.discriminatedUnion("authType", [
      z.object({
        apiKey: z.string().min(1),
        applicationKey: z.string().min(1),
        authType: z.literal("api_keys"),
        site: z.string().optional(),
      }),
      z.object({
        accessToken: z.string().min(1),
        authType: z.literal("oauth"),
        site: z.string().optional(),
      }),
    ]).parse(credentials);
    const headers = new Headers();
    if (parsed.authType === "api_keys") {
      headers.set("dd-api-key", parsed.apiKey);
      headers.set("dd-application-key", parsed.applicationKey);
    } else {
      headers.set("authorization", `Bearer ${parsed.accessToken}`);
    }
    return { headers, url: getDatadogSite(parsed.site).mcpUrl };
  }
  if (claim.account.provider === "sentry") {
    const sentry = await dependencies.freshSentryCredentials({
      encryptedCredentials: claim.account.encryptedCredentials,
      integrationAccountId: claim.account.id,
      organizationId: claim.organizationId,
    });
    if (!sentry) return null;
    const organizationSlug = z.string().min(1).parse(
      claim.account.metadata.organizationSlug,
    );
    const url = new URL(
      `/mcp/${encodeURIComponent(organizationSlug)}`,
      "https://mcp.sentry.dev",
    );
    url.searchParams.set("skills", "inspect");
    return {
      headers: new Headers({ authorization: `Sentry-Bearer ${sentry.accessToken}` }),
      url: url.toString(),
    };
  }
  if (claim.account.provider === "axiom") {
    const parsed = await dependencies.withCredentialLease({
      allowedStatuses: ["connected"],
      integrationAccountId: claim.account.id,
      operation: async (encryptedCredentials) => {
        const current = parseAxiomCredentials(
          decryptCredentials<Record<string, unknown>>(encryptedCredentials),
        );
        const oauth = await dependencies.refreshCustomMcp({
          mcpUrl: current.mcpUrl,
          oauth: current.oauth,
          redirectUrl: integrationCallbackUrl("axiom"),
        });
        if (oauth === current.oauth) return { value: current };
        const updated = { ...current, oauth };
        return {
          encryptedCredentials: encryptCredentials(updated),
          value: updated,
        };
      },
      organizationId: claim.organizationId,
      provider: "axiom",
    });
    const accessToken = parsed?.oauth.tokens?.access_token;
    if (!parsed || typeof accessToken !== "string") return null;
    return {
      headers: new Headers({ authorization: `Bearer ${accessToken}` }),
      url: parsed.mcpUrl,
    };
  }
  if (claim.account.provider === "custom_mcp") {
    const parsed = await dependencies.withCredentialLease<CustomMcpCredentials>({
      allowedStatuses: ["connected"],
      integrationAccountId: claim.account.id,
      operation: async (encryptedCredentials) => {
        const current = parseCustomMcpCredentials(
          decryptCredentials<Record<string, unknown>>(encryptedCredentials),
        );
        if (current.authType === "api_token") return { value: current };
        const oauth = await dependencies.refreshCustomMcp({
          mcpUrl: current.mcpUrl,
          oauth: current.oauth,
          redirectUrl: integrationCallbackUrl("custom_mcp"),
        });
        const updated = { ...current, oauth };
        return {
          encryptedCredentials: encryptCredentials(updated),
          value: updated,
        };
      },
      organizationId: claim.organizationId,
      provider: "custom_mcp",
    });
    if (!parsed) return null;
    const accessToken = parsed.authType === "api_token"
      ? parsed.apiToken
      : parsed.oauth.tokens?.access_token;
    if (!accessToken) return null;
    return {
      headers: new Headers({ authorization: `Bearer ${accessToken}` }),
      url: parsed.mcpUrl,
    };
  }
  return null;
}

// AWS and Google Cloud are reached through their managed MCP servers, which
// the broker filters to read-only tools.
function managedContextServer(
  claim: AutomationContextBrokerClaim,
  service: string | undefined,
  dependencies: ContextBrokerDependencies,
): ManagedMcpServer | null {
  if (!claim.account.encryptedCredentials) return null;
  const credentials = decryptCredentials<Record<string, unknown>>(
    claim.account.encryptedCredentials,
  );
  if (claim.account.provider === "aws") {
    return awsContextServer({
      accountId: claim.account.id,
      connection: awsConnectionCredentialsSchema.parse(credentials),
      dependencies: dependencies.aws,
    });
  }
  if (claim.account.provider === "gcp" && isGcpMcpService(service)) {
    return gcpContextServer({
      accountId: claim.account.id,
      connection: gcpConnectionCredentialsSchema.parse(credentials),
      dependencies: { ...dependencies.gcp, fetch: dependencies.providerFetch },
      service,
    });
  }
  return null;
}

async function grafanaCloudAccessToken(
  claim: AutomationContextBrokerClaim,
  dependencies: ContextBrokerDependencies,
): Promise<string> {
  const credentials = await dependencies.withCredentialLease({
    allowedStatuses: ["connected"],
    integrationAccountId: claim.account.id,
    operation: async (encryptedCredentials) => {
      const current = parseGrafanaCredentials(
        decryptCredentials<Record<string, unknown>>(encryptedCredentials),
      );
      if (current.authType !== "oauth") return { value: null };
      const oauth = await dependencies.refreshCustomMcp({
        mcpUrl: current.mcpUrl,
        oauth: current.oauth,
        redirectUrl: integrationCallbackUrl("grafana"),
      });
      if (oauth === current.oauth) return { value: current };
      const updated = { ...current, oauth };
      return {
        encryptedCredentials: encryptCredentials(updated),
        value: updated,
      };
    },
    organizationId: claim.organizationId,
    provider: "grafana",
  });
  const accessToken = credentials?.oauth.tokens?.access_token;
  if (typeof accessToken !== "string") {
    throw new Error("Reconnect the Grafana Cloud OAuth connection");
  }
  return accessToken;
}

async function cloudflareAccessToken(
  claim: AutomationContextBrokerClaim,
  dependencies: ContextBrokerDependencies,
): Promise<string> {
  const credentials = await dependencies.withCredentialLease({
    allowedStatuses: ["connected"],
    integrationAccountId: claim.account.id,
    operation: async (encryptedCredentials) => {
      const current = parseCloudflareCredentials(
        decryptCredentials<Record<string, unknown>>(encryptedCredentials),
      );
      const oauth = withCloudflareGrantScope(
        current.oauth,
        await dependencies.refreshCustomMcp({
          mcpUrl: current.mcpUrl,
          oauth: current.oauth,
          redirectUrl: integrationCallbackUrl("cloudflare"),
        }),
      );
      if (oauth === current.oauth) return { value: current };
      const updated = { ...current, oauth };
      return {
        encryptedCredentials: encryptCredentials(updated),
        value: updated,
      };
    },
    organizationId: claim.organizationId,
    provider: "cloudflare",
  });
  const accessToken = credentials?.oauth.tokens?.access_token;
  if (typeof accessToken !== "string") {
    throw new Error("Reconnect the Cloudflare OAuth connection");
  }
  // The API tool can reach any endpoint the grant allows.
  assertCloudflareReadOnlyGrant(credentials?.oauth.tokens);
  return accessToken;
}

// Serves one MCP request for a managed server: the broker answers tool
// listings itself and forwards only allowed calls.
async function managedServerResponse(input: {
  dependencies: ContextBrokerDependencies;
  rawBody: string;
  request: Request;
  rpc: z.infer<typeof requestSchema>;
  server: ManagedMcpServer;
}): Promise<Response> {
  const decision = await managedMcpDecision({
    method: input.rpc.method,
    params: input.rpc.params,
    server: input.server,
  });
  if (decision.kind === "accept") return new Response(null, { status: 202 });
  if (decision.kind === "list") {
    return Response.json(rpcResult(input.rpc.id, { tools: decision.tools }));
  }
  if (decision.kind === "reject") {
    return Response.json(
      rpcError(input.rpc.id, decision.code, decision.message),
      { status: decision.status },
    );
  }
  return await proxyMcpRequest({
    dependencies: input.dependencies,
    rawBody: input.rawBody,
    request: input.request,
    target: {
      fetch: input.server.fetch,
      headers: await input.server.headers(),
      url: input.server.url,
    },
  });
}

async function grafanaResponse(input: {
  claim: AutomationContextBrokerClaim;
  dependencies: ContextBrokerDependencies;
  rawBody: string;
  request: Request;
  rpc: z.infer<typeof requestSchema>;
}): Promise<Response> {
  const { claim, dependencies, rpc } = input;
  if (!claim.account.encryptedCredentials) {
    return Response.json(rpcError(rpc.id, -32601, "Connection does not expose context tools"), {
      status: 404,
    });
  }
  const credentials = parseGrafanaCredentials(
    decryptCredentials<Record<string, unknown>>(claim.account.encryptedCredentials),
  );
  if (credentials.authType === "oauth") {
    return await managedServerResponse({
      ...input,
      server: grafanaCloudContextServer({
        accessToken: () => grafanaCloudAccessToken(claim, dependencies),
        accountId: claim.account.id,
        fetch: dependencies.providerFetch,
        mcpUrl: credentials.mcpUrl,
        now: dependencies.grafana.now,
      }),
    });
  }
  const answer = await selfHostedGrafanaAnswer({
    accountId: claim.account.id,
    connection: credentials,
    dependencies: dependencies.grafana,
    method: rpc.method,
    params: rpc.params,
    signal: input.request.signal,
  });
  if (answer.kind === "accept") return new Response(null, { status: 202 });
  if (answer.kind === "reject") {
    return Response.json(rpcError(rpc.id, answer.code, answer.message), {
      status: answer.status,
    });
  }
  return Response.json(rpcResult(rpc.id, answer.result), {
    headers: { "cache-control": "no-store" },
  });
}

async function linearAccessToken(
  claim: AutomationContextBrokerClaim,
  dependencies: ContextBrokerDependencies,
): Promise<string | null> {
  const credentials = await dependencies.withCredentialLease({
    allowedStatuses: ["connected"],
    integrationAccountId: claim.account.id,
    operation: async (encryptedCredentials) => {
      const current = parseLinearOAuthCredentials(
        decryptCredentials<Record<string, unknown>>(encryptedCredentials),
      );
      if (!linearAccessTokenNeedsRefresh(current)) return { value: current };
      const updated = await dependencies.refreshLinear({ credentials: current });
      return {
        encryptedCredentials: encryptCredentials(updated),
        value: updated,
      };
    },
    organizationId: claim.organizationId,
    provider: "linear",
  });
  return credentials?.accessToken ?? null;
}

// Linear is served here rather than proxied, so the run gets Linear's
// read-only tools plus create_issue under one server.
async function linearResponse(
  claim: AutomationContextBrokerClaim,
  request: z.infer<typeof requestSchema>,
  dependencies: ContextBrokerDependencies,
): Promise<Response> {
  if (request.method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }
  if (request.method === "initialize") {
    const requestedVersion = z.string().safeParse(request.params?.protocolVersion);
    return Response.json(rpcResult(request.id, {
      capabilities: { tools: {} },
      protocolVersion: requestedVersion.success
        ? requestedVersion.data
        : "2025-03-26",
      serverInfo: { name: "responder-linear", version: "1" },
    }));
  }
  if (request.method === "ping") return Response.json(rpcResult(request.id, {}));
  if (request.method !== "tools/list" && request.method !== "tools/call") {
    return Response.json(rpcError(request.id, -32601, "Method not found"), {
      status: 404,
    });
  }
  const accessToken = await linearAccessToken(claim, dependencies);
  if (!accessToken) {
    return Response.json(rpcError(request.id, -32601, "Connection does not expose context tools"), {
      status: 404,
    });
  }
  if (request.method === "tools/list") {
    return Response.json(rpcResult(request.id, {
      tools: await linearToolDefinitions(accessToken, dependencies.linear),
    }));
  }
  const toolName = z.string().safeParse(request.params?.name);
  if (!toolName.success) {
    return Response.json(rpcError(request.id, -32602, "Invalid tool arguments"), {
      status: 400,
    });
  }
  return Response.json(rpcResult(request.id, await callLinearTool({
    accessToken,
    args: request.params?.arguments,
    claim,
    dependencies: dependencies.linear,
    name: toolName.data,
  })));
}

// Vercel has no MCP server, so the broker serves the investigation tools.
async function vercelResponse(
  claim: AutomationContextBrokerClaim,
  request: z.infer<typeof requestSchema>,
  signal: AbortSignal,
  dependencies: ContextBrokerDependencies,
): Promise<Response> {
  if (request.method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }
  if (request.method === "initialize") {
    const requestedVersion = z.string().safeParse(request.params?.protocolVersion);
    return Response.json(rpcResult(request.id, {
      capabilities: { tools: {} },
      protocolVersion: requestedVersion.success
        ? requestedVersion.data
        : "2025-03-26",
      serverInfo: { name: "responder-vercel", version: "1" },
    }));
  }
  if (request.method === "ping") return Response.json(rpcResult(request.id, {}));
  if (request.method !== "tools/list" && request.method !== "tools/call") {
    return Response.json(rpcError(request.id, -32601, "Method not found"), {
      status: 404,
    });
  }
  const connection = vercelContextConnection(claim);
  if (!connection) {
    return Response.json(rpcError(request.id, -32601, "Connection does not expose context tools"), {
      status: 404,
    });
  }
  if (request.method === "tools/list") {
    return Response.json(rpcResult(request.id, { tools: vercelToolDefinitions }));
  }
  const toolName = z.string().safeParse(request.params?.name);
  if (!toolName.success) {
    return Response.json(rpcError(request.id, -32602, "Invalid tool arguments"), {
      status: 400,
    });
  }
  const result = await callVercelTool({
    args: request.params?.arguments,
    connection,
    dependencies: dependencies.vercel,
    name: toolName.data,
    signal,
  });
  if (!result) {
    return Response.json(rpcError(request.id, -32602, "Unknown tool"), {
      status: 400,
    });
  }
  return Response.json(rpcResult(request.id, result));
}

async function slackResponse(
  claim: AutomationContextBrokerClaim,
  request: z.infer<typeof requestSchema>,
  signal: AbortSignal,
  dependencies: ContextBrokerDependencies,
): Promise<Response> {
  if (request.method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }
  if (request.method === "initialize") {
    const requestedVersion = z.string().safeParse(request.params?.protocolVersion);
    return Response.json(rpcResult(request.id, {
      capabilities: { tools: {} },
      protocolVersion: requestedVersion.success
        ? requestedVersion.data
        : "2025-03-26",
      serverInfo: { name: "responder-slack", version: "2" },
    }));
  }
  if (request.method === "tools/list") {
    return Response.json(rpcResult(request.id, {
      tools: slackToolDefinitions(slackToolScope(claim)),
    }));
  }
  if (request.method !== "tools/call") {
    return Response.json(rpcError(request.id, -32601, "Method not found"), {
      status: 404,
    });
  }
  const toolName = z.string().safeParse(request.params?.name);
  if (!toolName.success) {
    return Response.json(rpcError(request.id, -32602, "Invalid tool arguments"), {
      status: 400,
    });
  }
  try {
    const result = await callSlackTool({
      args: request.params?.arguments,
      claim,
      dependencies: dependencies.slack,
      name: toolName.data,
      signal,
    });
    return Response.json(rpcResult(request.id, result));
  } catch (error) {
    if (error instanceof UnknownSlackToolError) {
      return Response.json(rpcError(request.id, -32602, "Unknown tool"), {
        status: 400,
      });
    }
    throw error;
  }
}

// Forwards one MCP request with the provider credential added on the server.
async function proxyMcpRequest(input: {
  dependencies: ContextBrokerDependencies;
  rawBody: string;
  request: Request;
  target: {
    fetch?: (input: string, init: RequestInit) => Promise<Response>;
    headers: Headers;
    url: string;
  };
}): Promise<Response> {
  for (const header of [
    "accept",
    "content-type",
    "mcp-protocol-version",
    "mcp-session-id",
  ]) {
    const value = input.request.headers.get(header);
    if (value) input.target.headers.set(header, value);
  }
  const fetch = input.target.fetch ?? input.dependencies.providerFetch;
  const response = await fetch(input.target.url, {
    body: input.rawBody,
    headers: input.target.headers,
    method: "POST",
    signal: input.request.signal,
  });
  const headers = new Headers({ "cache-control": "no-store" });
  for (const name of [
    "content-type",
    "mcp-protocol-version",
    "mcp-session-id",
    "retry-after",
  ]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export function createAutomationContextBrokerRoutes(
  overrides: Partial<ContextBrokerDependencies> = {},
) {
  const dependencies: ContextBrokerDependencies = {
    ...defaultDependencies,
    ...overrides,
  };
  return new Hono().post("/v1/:integrationAccountId/:service?", async (context) => {
    const service = context.req.param("service");
    const token = readAutomationModelBrokerBearerToken(
      context.req.header("authorization") ?? null,
    );
    const accountId = accountIdSchema.safeParse(
      context.req.param("integrationAccountId"),
    );
    if (!token || !accountId.success) {
      return context.json({ error: "Unauthorized" }, 401);
    }
    const claim = await dependencies.resolveGrant({
      integrationAccountId: accountId.data,
      tokenHash: automationModelBrokerTokenHash(token),
    });
    if (!claim) return context.json({ error: "Unauthorized" }, 401);
    const rawBody = await context.req.text();
    const parsed = requestSchema.safeParse(
      (() => {
        try {
          return JSON.parse(rawBody);
        } catch {
          return null;
        }
      })(),
    );
    if (!parsed.success) {
      return context.json(rpcError(undefined, -32700, "Invalid MCP request"), 400);
    }
    // Only Google Cloud splits a connection into one endpoint per service.
    if (service && claim.account.provider !== "gcp") {
      return context.json(rpcError(parsed.data.id, -32601, "Connection does not expose context tools"), 404);
    }
    try {
      if (claim.account.provider === "slack") {
        return await slackResponse(
          claim,
          parsed.data,
          context.req.raw.signal,
          dependencies,
        );
      }
      if (claim.account.provider === "linear") {
        return await linearResponse(claim, parsed.data, dependencies);
      }
      if (claim.account.provider === "vercel") {
        return await vercelResponse(
          claim,
          parsed.data,
          context.req.raw.signal,
          dependencies,
        );
      }
      if (claim.account.provider === "aws" || claim.account.provider === "gcp") {
        if (claim.account.provider === "gcp" && !isGcpMcpService(service)) {
          return context.json(rpcError(parsed.data.id, -32601, "Unknown Google Cloud service"), 404);
        }
        const server = managedContextServer(claim, service, dependencies);
        if (!server) {
          return context.json(rpcError(parsed.data.id, -32601, "Connection does not expose context tools"), 404);
        }
        return await managedServerResponse({
          dependencies,
          rawBody,
          request: context.req.raw,
          rpc: parsed.data,
          server,
        });
      }
      if (claim.account.provider === "cloudflare") {
        if (!claim.account.encryptedCredentials) {
          return context.json(rpcError(parsed.data.id, -32601, "Connection does not expose context tools"), 404);
        }
        const credentials = parseCloudflareCredentials(
          decryptCredentials<Record<string, unknown>>(claim.account.encryptedCredentials),
        );
        return await managedServerResponse({
          dependencies,
          rawBody,
          request: context.req.raw,
          rpc: parsed.data,
          server: cloudflareContextServer({
            accessToken: () => cloudflareAccessToken(claim, dependencies),
            accountId: claim.account.id,
            fetch: dependencies.providerFetch,
            mcpUrl: credentials.mcpUrl,
            now: dependencies.cloudflare.now,
          }),
        });
      }
      if (claim.account.provider === "grafana") {
        return await grafanaResponse({
          claim,
          dependencies,
          rawBody,
          request: context.req.raw,
          rpc: parsed.data,
        });
      }
      const target = await providerTarget(claim, dependencies);
      if (!target) {
        return context.json(rpcError(parsed.data.id, -32601, "Connection does not expose context tools"), 404);
      }
      return await proxyMcpRequest({
        dependencies,
        rawBody,
        request: context.req.raw,
        target,
      });
    } catch (error) {
      console.error(JSON.stringify({
        accountId: claim.account.id,
        errorCode: error instanceof Error ? error.name : typeof error,
        event: "automation_context_broker_request_failed",
        organizationId: claim.organizationId,
        provider: claim.account.provider,
        runId: claim.runId,
      }));
      return context.json(rpcError(parsed.data.id, -32603, "Context provider request failed"), 502);
    }
  });
}
