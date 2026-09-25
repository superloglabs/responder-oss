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
import { getDatadogSite } from "../../../../packages/core/src/integrations/datadog.js";
import {
  parseCustomMcpCredentials,
  refreshCustomMcpOAuth,
  safeCustomMcpFetch,
  type CustomMcpCredentials,
} from "../../../../packages/core/src/integrations/custom-mcp.js";
import { integrationCallbackUrl } from "../integrations/urls.js";
import {
  callSlackTool,
  defaultSlackToolDependencies,
  slackToolDefinitions,
  slackToolScope,
  UnknownSlackToolError,
  type SlackToolDependencies,
} from "./slack-tools.js";

const accountIdSchema = z.uuid();
const requestSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

type ResolveGrant = typeof resolveAutomationContextBrokerGrant;

interface ContextBrokerDependencies {
  providerFetch: typeof safeCustomMcpFetch;
  refreshCustomMcp: typeof refreshCustomMcpOAuth;
  resolveGrant: ResolveGrant;
  slack: SlackToolDependencies;
  withCredentialLease: typeof withIntegrationAccountCredentialLease;
}

const defaultDependencies: ContextBrokerDependencies = {
  providerFetch: safeCustomMcpFetch,
  refreshCustomMcp: refreshCustomMcpOAuth,
  resolveGrant: resolveAutomationContextBrokerGrant,
  slack: defaultSlackToolDependencies,
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
    const parsed = z.object({ accessToken: z.string().min(1) }).parse(credentials);
    const organizationSlug = z.string().min(1).parse(
      claim.account.metadata.organizationSlug,
    );
    const url = new URL(
      `/mcp/${encodeURIComponent(organizationSlug)}`,
      "https://mcp.sentry.dev",
    );
    url.searchParams.set("skills", "inspect");
    return {
      headers: new Headers({ authorization: `Sentry-Bearer ${parsed.accessToken}` }),
      url: url.toString(),
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

export function createAutomationContextBrokerRoutes(
  overrides: Partial<ContextBrokerDependencies> = {},
) {
  const dependencies: ContextBrokerDependencies = {
    ...defaultDependencies,
    ...overrides,
  };
  return new Hono().post("/v1/:integrationAccountId", async (context) => {
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
    try {
      if (claim.account.provider === "slack") {
        return await slackResponse(
          claim,
          parsed.data,
          context.req.raw.signal,
          dependencies,
        );
      }
      const target = await providerTarget(claim, dependencies);
      if (!target) {
        return context.json(rpcError(parsed.data.id, -32601, "Connection does not expose context tools"), 404);
      }
      for (const header of [
        "accept",
        "content-type",
        "mcp-protocol-version",
        "mcp-session-id",
      ]) {
        const value = context.req.header(header);
        if (value) target.headers.set(header, value);
      }
      const response = await dependencies.providerFetch(target.url, {
        body: rawBody,
        headers: target.headers,
        method: "POST",
        signal: context.req.raw.signal,
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
