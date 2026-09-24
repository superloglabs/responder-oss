import { automationModelProviderSchema } from "../../../../packages/core/src/automations/config.js";
import { modelProvider, type ModelProviderId } from "../../../../packages/core/src/automations/model-providers.js";
import { Hono } from "hono";
import {
  automationModelBrokerTokenHash,
  readAutomationModelBrokerBearerToken,
} from "../../../../packages/core/src/automations/model-broker.js";
import {
  claimAutomationModelBrokerGrant,
  type AutomationModelBrokerClaim,
} from "../../../../packages/core/src/db/automation-model-broker.js";

export const openAIResponsesEndpoint = "https://api.openai.com/v1/responses";
export const anthropicMessagesEndpoint = "https://api.anthropic.com/v1/messages";

const providerRequestTimeoutMs = 10 * 60_000;
const modelIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/u;

type ClaimGrant = (input: {
  model: string;
  provider: ModelProviderId;
  requestedMaxOutputTokens: number | null;
  tokenHash: string;
}) => Promise<AutomationModelBrokerClaim | null>;

type ProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface AutomationModelBrokerDependencies {
  claimGrant: ClaimGrant;
  providerFetch: ProviderFetch;
}

const defaultDependencies: AutomationModelBrokerDependencies = {
  claimGrant: claimAutomationModelBrokerGrant,
  providerFetch: fetch,
};

interface ParsedResponsesRequest {
  body: Record<string, unknown>;
  model: string;
  requestedMaxOutputTokens: number | null;
}

interface ParsedMessagesRequest {
  body: Record<string, unknown>;
  model: string;
  requestedMaxOutputTokens: number;
}

function parseResponsesRequest(value: unknown): ParsedResponsesRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    typeof body.model !== "string" ||
    !modelIdentifierPattern.test(body.model)
  ) {
    return null;
  }
  if (body.background !== undefined && body.background !== false) return null;

  const configuredMaxOutputTokens = body.max_output_tokens;
  if (
    configuredMaxOutputTokens !== undefined &&
    configuredMaxOutputTokens !== null &&
    (!Number.isSafeInteger(configuredMaxOutputTokens) ||
      (configuredMaxOutputTokens as number) <= 0)
  ) {
    return null;
  }
  return {
    body,
    model: body.model,
    requestedMaxOutputTokens:
      typeof configuredMaxOutputTokens === "number"
        ? configuredMaxOutputTokens
        : null,
  };
}

function providerResponseHeaders(headers: Headers): Headers {
  const forwarded = new Headers({ "cache-control": "no-store" });
  for (const name of [
    "content-type",
    "anthropic-organization-id",
    "openai-processing-ms",
    "request-id",
    "x-request-id",
  ]) {
    const value = headers.get(name);
    if (value) forwarded.set(name, value);
  }
  return forwarded;
}

function brokerToken(context: { req: { header(name: string): string | undefined } }): string | null {
  return readAutomationModelBrokerBearerToken(
    context.req.header("authorization") ?? null,
  ) ?? readAutomationModelBrokerBearerToken(
    `Bearer ${context.req.header("x-api-key") ?? ""}`,
  );
}

function parseMessagesRequest(value: unknown): ParsedMessagesRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    typeof body.model !== "string" ||
    !modelIdentifierPattern.test(body.model) ||
    !Number.isSafeInteger(body.max_tokens) ||
    (body.max_tokens as number) <= 0
  ) {
    return null;
  }
  return {
    body,
    model: body.model,
    requestedMaxOutputTokens: body.max_tokens as number,
  };
}

export function createAutomationModelBrokerRoutes(
  dependencies: AutomationModelBrokerDependencies = defaultDependencies,
) {
  return new Hono().post("/v1/providers/:provider/chat/completions", async (context) => {
    const provider = automationModelProviderSchema.safeParse(context.req.param("provider"));
    if (!provider.success || ["openai", "anthropic"].includes(provider.data)) return context.json({ error: "Unsupported provider" }, 400);
    const token = brokerToken(context);
    if (!token) return context.json({ error: "Unauthorized" }, 401);
    const body = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.model !== "string" || !modelIdentifierPattern.test(body.model) || !Array.isArray(body.messages)) return context.json({ error: "Invalid model request" }, 400);
    const limits = [body.max_tokens, body.max_completion_tokens].filter(value => value !== undefined && value !== null);
    if (limits.some(value => !Number.isSafeInteger(value) || (value as number) <= 0) || (body.n !== undefined && body.n !== 1)) return context.json({ error: "Invalid model request limits" }, 400);
    let grant: AutomationModelBrokerClaim | null;
    try { grant = await dependencies.claimGrant({ model: body.model, provider: provider.data, requestedMaxOutputTokens: limits.length ? Math.max(...limits as number[]) : null, tokenHash: automationModelBrokerTokenHash(token) }); }
    catch { return context.json({ error: "Model broker is unavailable" }, 503); }
    if (!grant) return context.json({ error: "Model broker grant is invalid or exhausted" }, 401);
    const forwarded: Record<string, unknown> = { ...body, model: grant.model, max_tokens: grant.maxOutputTokens };
    delete forwarded.max_completion_tokens;
    try {
      const response = await dependencies.providerFetch(`${modelProvider(provider.data).baseUrl}/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${grant.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(forwarded), redirect: "error",
        signal: AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(providerRequestTimeoutMs)]),
      });
      return new Response(response.body, { status: response.status, headers: providerResponseHeaders(response.headers) });
    } catch { return context.json({ error: "Model provider request failed" }, 502); }
  }).post("/v1/responses", async (context) => {
    const token = brokerToken(context);
    if (!token) return context.json({ error: "Unauthorized" }, 401);

    const parsed = parseResponsesRequest(
      await context.req.json().catch(() => null),
    );
    if (!parsed) {
      return context.json({ error: "Invalid model provider request" }, 400);
    }

    let grant: AutomationModelBrokerClaim | null;
    try {
      grant = await dependencies.claimGrant({
        model: parsed.model,
        provider: "openai",
        requestedMaxOutputTokens: parsed.requestedMaxOutputTokens,
        tokenHash: automationModelBrokerTokenHash(token),
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          errorCode: error instanceof Error ? error.constructor.name : "unknown",
          event: "automation_model_broker_claim_failed",
        }),
      );
      return context.json({ error: "Model broker is unavailable" }, 503);
    }
    if (!grant) {
      return context.json(
        { error: "Model broker grant is invalid or exhausted" },
        401,
      );
    }

    const providerBody = {
      ...parsed.body,
      background: false,
      max_output_tokens: grant.maxOutputTokens,
      model: grant.model,
    };
    let providerResponse: Response;
    try {
      providerResponse = await dependencies.providerFetch(
        openAIResponsesEndpoint,
        {
          body: JSON.stringify(providerBody),
          headers: {
            authorization: `Bearer ${grant.apiKey}`,
            "content-type": "application/json",
          },
          method: "POST",
          signal: AbortSignal.any([
            context.req.raw.signal,
            AbortSignal.timeout(providerRequestTimeoutMs),
          ]),
        },
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          errorCode: error instanceof Error ? error.constructor.name : "unknown",
          event: "automation_model_provider_request_failed",
          grantId: grant.grantId,
          organizationId: grant.organizationId,
          runId: grant.runId,
        }),
      );
      return context.json({ error: "Model provider request failed" }, 502);
    }

    return new Response(providerResponse.body, {
      headers: providerResponseHeaders(providerResponse.headers),
      status: providerResponse.status,
      statusText: providerResponse.statusText,
    });
  }).post("/v1/messages", async (context) => {
    const token = brokerToken(context);
    if (!token) return context.json({ error: "Unauthorized" }, 401);

    const parsed = parseMessagesRequest(
      await context.req.json().catch(() => null),
    );
    if (!parsed) {
      return context.json({ error: "Invalid model provider request" }, 400);
    }

    let grant: AutomationModelBrokerClaim | null;
    try {
      grant = await dependencies.claimGrant({
        model: parsed.model,
        provider: "anthropic",
        requestedMaxOutputTokens: parsed.requestedMaxOutputTokens,
        tokenHash: automationModelBrokerTokenHash(token),
      });
    } catch (error) {
      console.error(JSON.stringify({
        errorCode: error instanceof Error ? error.constructor.name : "unknown",
        event: "automation_model_broker_claim_failed",
      }));
      return context.json({ error: "Model broker is unavailable" }, 503);
    }
    if (!grant) {
      return context.json(
        { error: "Model broker grant is invalid or exhausted" },
        401,
      );
    }

    let providerResponse: Response;
    try {
      const headers = new Headers({
        "anthropic-version": context.req.header("anthropic-version") ?? "2023-06-01",
        "content-type": "application/json",
        "x-api-key": grant.apiKey,
      });
      const beta = context.req.header("anthropic-beta");
      if (beta) headers.set("anthropic-beta", beta);
      providerResponse = await dependencies.providerFetch(
        anthropicMessagesEndpoint,
        {
          body: JSON.stringify({
            ...parsed.body,
            max_tokens: grant.maxOutputTokens,
            model: grant.model,
          }),
          headers,
          method: "POST",
          signal: AbortSignal.any([
            context.req.raw.signal,
            AbortSignal.timeout(providerRequestTimeoutMs),
          ]),
        },
      );
    } catch (error) {
      console.error(JSON.stringify({
        errorCode: error instanceof Error ? error.constructor.name : "unknown",
        event: "automation_model_provider_request_failed",
        grantId: grant.grantId,
        organizationId: grant.organizationId,
        runId: grant.runId,
      }));
      return context.json({ error: "Model provider request failed" }, 502);
    }

    return new Response(providerResponse.body, {
      headers: providerResponseHeaders(providerResponse.headers),
      status: providerResponse.status,
      statusText: providerResponse.statusText,
    });
  });
}

export const automationModelBrokerRoutes = createAutomationModelBrokerRoutes();
