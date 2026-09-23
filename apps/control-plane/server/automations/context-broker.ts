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
import { decryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import { getDatadogSite } from "../../../../packages/core/src/integrations/datadog.js";
import {
  parseCustomMcpCredentials,
  safeCustomMcpFetch,
} from "../../../../packages/core/src/integrations/custom-mcp.js";
import { searchSlackChannel } from "../../../../packages/core/src/integrations/slack-search.js";

const accountIdSchema = z.uuid();
const requestSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});
const slackToolInputSchema = z.object({
  channel_id: z.string().min(1),
  limit: z.number().int().min(1).max(20).default(10),
  query: z.string().min(1).max(500),
});

type ResolveGrant = typeof resolveAutomationContextBrokerGrant;

interface ContextBrokerDependencies {
  providerFetch: typeof safeCustomMcpFetch;
  resolveGrant: ResolveGrant;
  slackSearch: typeof searchSlackChannel;
}

const defaultDependencies: ContextBrokerDependencies = {
  providerFetch: safeCustomMcpFetch,
  resolveGrant: resolveAutomationContextBrokerGrant,
  slackSearch: searchSlackChannel,
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

function providerTarget(claim: AutomationContextBrokerClaim): {
  headers: Headers;
  url: string;
} | null {
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
    const parsed = parseCustomMcpCredentials(credentials);
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
      serverInfo: { name: "responder-slack-context", version: "1" },
    }));
  }
  const channels = claim.resources.filter((resource) =>
    resource.kind === "slack_channel"
  );
  if (request.method === "tools/list") {
    return Response.json(rpcResult(request.id, {
      tools: [{
        annotations: { readOnlyHint: true },
        description: "Search messages in a Slack channel from this connected workspace.",
        inputSchema: {
          additionalProperties: false,
          properties: {
            channel_id: {
              enum: channels.map((channel) => channel.externalId),
              type: "string",
            },
            limit: { default: 10, maximum: 20, minimum: 1, type: "integer" },
            query: { maxLength: 500, minLength: 1, type: "string" },
          },
          required: ["channel_id", "query"],
          type: "object",
        },
        name: "slack_search_channel",
      }],
    }));
  }
  if (request.method !== "tools/call") {
    return Response.json(rpcError(request.id, -32601, "Method not found"), {
      status: 404,
    });
  }
  const toolName = z.string().safeParse(request.params?.name);
  const toolInput = slackToolInputSchema.safeParse(request.params?.arguments);
  if (!toolName.success || toolName.data !== "slack_search_channel" || !toolInput.success) {
    return Response.json(rpcError(request.id, -32602, "Invalid tool arguments"), {
      status: 400,
    });
  }
  const channel = channels.find((candidate) =>
    candidate.externalId === toolInput.data.channel_id
  );
  if (!channel || !claim.account.encryptedCredentials) {
    return Response.json(rpcError(request.id, -32602, "Slack channel is unavailable"), {
      status: 400,
    });
  }
  const credentials = z.object({ userAccessToken: z.string().min(1) }).parse(
    decryptCredentials<Record<string, unknown>>(
      claim.account.encryptedCredentials,
    ),
  );
  const result = await dependencies.slackSearch({
    accessToken: credentials.userAccessToken,
    channel: { id: channel.externalId, name: channel.displayName },
    limit: toolInput.data.limit,
    query: toolInput.data.query,
  });
  return Response.json(rpcResult(request.id, {
    content: [{ text: JSON.stringify(result), type: "text" }],
  }));
}

export function createAutomationContextBrokerRoutes(
  dependencies: ContextBrokerDependencies = defaultDependencies,
) {
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
        return await slackResponse(claim, parsed.data, dependencies);
      }
      const target = providerTarget(claim);
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
