import { Hono, type Context } from "hono";
import { automationModelProviderSchema } from "../../../../packages/core/src/automations/config.js";
import { modelProvider, type ModelProviderId } from "../../../../packages/core/src/automations/model-providers.js";
import {
  automationModelBrokerTokenHash,
  readAutomationModelBrokerBearerToken,
} from "../../../../packages/core/src/automations/model-broker.js";
import {
  aiGatewayBaseUrl,
  aiGatewayModelId,
  automationModelCostMicros,
  getAIGatewayModelPricing,
} from "../../../../packages/core/src/automations/model-pricing.js";
import {
  completeResponderInference,
  recordBrokeredModelUsage,
  releaseResponderInference,
  reserveResponderInference,
} from "../../../../packages/core/src/automations/model-usage-billing.js";
import {
  createAutomationModelUsageObserver,
  type AutomationModelUsage,
  type AutomationModelWireFormat,
} from "../../../../packages/core/src/automations/model-usage.js";
import {
  claimAutomationModelBrokerGrant,
  type AutomationModelBrokerClaim,
} from "../../../../packages/core/src/db/automation-model-broker.js";

export const openAIResponsesEndpoint = "https://api.openai.com/v1/responses";
export const anthropicMessagesEndpoint = "https://api.anthropic.com/v1/messages";
export const aiGatewayResponsesEndpoint = `${aiGatewayBaseUrl}/responses`;
export const aiGatewayMessagesEndpoint = `${aiGatewayBaseUrl}/messages`;
export const aiGatewayChatCompletionsEndpoint = `${aiGatewayBaseUrl}/chat/completions`;

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
  completeInference: typeof completeResponderInference;
  gatewayApiKey(): string | undefined;
  getPricing: typeof getAIGatewayModelPricing;
  providerFetch: ProviderFetch;
  recordUsage: typeof recordBrokeredModelUsage;
  releaseInference: typeof releaseResponderInference;
  reserveInference: typeof reserveResponderInference;
}

const defaultDependencies: AutomationModelBrokerDependencies = {
  claimGrant: claimAutomationModelBrokerGrant,
  completeInference: completeResponderInference,
  gatewayApiKey: () => process.env.AI_GATEWAY_API_KEY?.trim() || undefined,
  getPricing: getAIGatewayModelPricing,
  providerFetch: fetch,
  recordUsage: recordBrokeredModelUsage,
  releaseInference: releaseResponderInference,
  reserveInference: reserveResponderInference,
};

interface ProviderRequest {
  body: Record<string, unknown>;
  headers: Headers;
  // The pending usage row that holds a Responder-funded request's estimated cost.
  reservationId?: string;
  url: string;
}

class BrokerRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 402 | 409 | 503,
  ) {
    super(message);
  }
}

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

function brokerToken(context: Context): string | null {
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

function logBrokerError(
  event: string,
  error: unknown,
  grant?: AutomationModelBrokerClaim,
): void {
  console.error(JSON.stringify({
    errorCode: error instanceof Error ? error.constructor.name : "unknown",
    event,
    ...(grant
      ? {
          grantId: grant.grantId,
          organizationId: grant.organizationId,
          runId: grant.runId,
        }
      : {}),
  }));
}

// Forwards the provider body unchanged while reading its token usage. When
// `drainOnCancel` is set, a client disconnect does not stop the upstream read:
// the provider still bills the whole response, so usage is read to the end.
function meteredBody(
  body: ReadableStream<Uint8Array>,
  observer: ReturnType<typeof createAutomationModelUsageObserver>,
  onFinish: (usage: AutomationModelUsage | null) => void,
  drainOnCancel: boolean,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onFinish(observer.finish());
  };
  const drain = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        observer.observe(value);
      }
    } catch {
      // The provider timeout or a network error ends the drain.
    }
    finish();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
          return;
        }
        observer.observe(value);
        controller.enqueue(value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (drainOnCancel) {
        void drain();
        return;
      }
      finish();
      await reader.cancel(reason);
    },
  });
}

function brokerResponse(
  providerResponse: Response,
  format: AutomationModelWireFormat,
  grant: AutomationModelBrokerClaim,
  dependencies: AutomationModelBrokerDependencies,
  reservationId: string | undefined,
): Response {
  const headers = providerResponseHeaders(providerResponse.headers);
  if (reservationId && !providerResponse.body) {
    releaseReservation(reservationId, grant, dependencies);
  }
  const body = providerResponse.body && providerResponse.ok
    ? meteredBody(
        providerResponse.body,
        createAutomationModelUsageObserver(
          format,
          providerResponse.headers.get("content-type"),
        ),
        (usage) => {
          const recorded = reservationId
            ? usage
              ? dependencies.completeInference({
                  model: grant.model,
                  provider: grant.provider,
                  reservationId,
                  usage,
                })
              : dependencies.releaseInference(reservationId)
            : usage
              ? dependencies.recordUsage({
                  inferenceSource: grant.inferenceSource,
                  model: grant.model,
                  organizationId: grant.organizationId,
                  provider: grant.provider,
                  runId: grant.runId,
                  usage,
                })
              : Promise.resolve();
          void recorded.catch((error: unknown) => {
            logBrokerError("automation_model_usage_record_failed", error, grant);
          });
        },
        grant.inferenceSource === "responder",
      )
    : providerResponse.body;
  return new Response(body, {
    headers,
    status: providerResponse.status,
    statusText: providerResponse.statusText,
  });
}

// Byte-level tokenizers never produce more tokens than UTF-8 bytes, so the
// request's byte size is a strict upper bound on its input tokens. Pricing
// that count also selects the most expensive applicable long-context tier.

async function reserveResponderRequest(
  grant: AutomationModelBrokerClaim,
  body: Record<string, unknown>,
  dependencies: AutomationModelBrokerDependencies,
): Promise<{ apiKey: string; reservationId: string }> {
  const apiKey = dependencies.gatewayApiKey();
  if (!apiKey) {
    throw new BrokerRequestError(
      "Responder-funded inference is not configured",
      503,
    );
  }
  // Included usage is billed from gateway pricing, so an unpriced model
  // cannot be metered and is refused.
  const pricing = await dependencies.getPricing(
    aiGatewayModelId(grant.provider, grant.model),
  ).catch(() => {
    throw new BrokerRequestError("Model pricing is unavailable", 503);
  });
  const estimateMicros = pricing
    ? automationModelCostMicros(pricing, {
        cacheWriteTokens: 0,
        cachedInputTokens: 0,
        inputTokens: Buffer.byteLength(JSON.stringify(body), "utf8"),
        outputTokens: grant.maxOutputTokens,
      })
    : null;
  if (estimateMicros === null) {
    throw new BrokerRequestError(
      `${grant.model} is not available with included usage`,
      409,
    );
  }
  let reservationId: string | null;
  try {
    reservationId = await dependencies.reserveInference({
      estimateMicros,
      model: grant.model,
      organizationId: grant.organizationId,
      provider: grant.provider,
      runId: grant.runId,
    });
  } catch (error) {
    logBrokerError("automation_model_usage_reservation_failed", error, grant);
    throw new BrokerRequestError("Model broker is unavailable", 503);
  }
  if (!reservationId) {
    throw new BrokerRequestError(
      "The automation usage allowance for this billing period is used up",
      402,
    );
  }
  return { apiKey, reservationId };
}

async function openAIProviderRequest(
  body: Record<string, unknown>,
  grant: AutomationModelBrokerClaim,
  dependencies: AutomationModelBrokerDependencies,
): Promise<ProviderRequest> {
  const limitedBody = {
    ...body,
    background: false,
    max_output_tokens: grant.maxOutputTokens,
  };
  if (grant.inferenceSource === "responder") {
    const forwarded = { ...limitedBody, model: aiGatewayModelId("openai", grant.model) };
    const { apiKey, reservationId } = await reserveResponderRequest(grant, forwarded, dependencies);
    return {
      body: forwarded,
      headers: new Headers({
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      }),
      reservationId,
      url: aiGatewayResponsesEndpoint,
    };
  }
  return {
    body: { ...limitedBody, model: grant.model },
    headers: new Headers({
      authorization: `Bearer ${grant.apiKey}`,
      "content-type": "application/json",
    }),
    url: openAIResponsesEndpoint,
  };
}

async function anthropicProviderRequest(
  context: Context,
  body: Record<string, unknown>,
  grant: AutomationModelBrokerClaim,
  dependencies: AutomationModelBrokerDependencies,
): Promise<ProviderRequest> {
  const headers = new Headers({
    "anthropic-version": context.req.header("anthropic-version") ?? "2023-06-01",
    "content-type": "application/json",
  });
  const beta = context.req.header("anthropic-beta");
  if (beta) headers.set("anthropic-beta", beta);
  const limitedBody = { ...body, max_tokens: grant.maxOutputTokens };
  if (grant.inferenceSource === "responder") {
    const forwarded = { ...limitedBody, model: aiGatewayModelId("anthropic", grant.model) };
    const { apiKey, reservationId } = await reserveResponderRequest(grant, forwarded, dependencies);
    headers.set("authorization", `Bearer ${apiKey}`);
    return {
      body: forwarded,
      headers,
      reservationId,
      url: aiGatewayMessagesEndpoint,
    };
  }
  if (!grant.apiKey) {
    throw new BrokerRequestError("Model credential is unavailable", 409);
  }
  headers.set("x-api-key", grant.apiKey);
  return {
    body: { ...limitedBody, model: grant.model },
    headers,
    url: anthropicMessagesEndpoint,
  };
}

async function chatCompletionsProviderRequest(
  body: Record<string, unknown>,
  grant: AutomationModelBrokerClaim,
  dependencies: AutomationModelBrokerDependencies,
): Promise<ProviderRequest> {
  const forwarded: Record<string, unknown> = { ...body, max_tokens: grant.maxOutputTokens };
  delete forwarded.max_completion_tokens;
  if (grant.provider === "openai") {
    delete forwarded.max_tokens;
    forwarded.max_completion_tokens = grant.maxOutputTokens;
  }
  if (grant.inferenceSource === "responder") {
    // Streamed chat completions only report usage when asked to.
    if (forwarded.stream === true) {
      const streamOptions = forwarded.stream_options;
      forwarded.stream_options = {
        ...(streamOptions && typeof streamOptions === "object" ? streamOptions : {}),
        include_usage: true,
      };
    }
    const gatewayBody = { ...forwarded, model: aiGatewayModelId(grant.provider, grant.model) };
    const { apiKey, reservationId } = await reserveResponderRequest(grant, gatewayBody, dependencies);
    return {
      body: gatewayBody,
      headers: new Headers({
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      }),
      reservationId,
      url: aiGatewayChatCompletionsEndpoint,
    };
  }
  if (!grant.apiKey) {
    throw new BrokerRequestError("Model credential is unavailable", 409);
  }
  return {
    body: { ...forwarded, model: grant.model },
    headers: new Headers({
      authorization: `Bearer ${grant.apiKey}`,
      "content-type": "application/json",
    }),
    url: `${modelProvider(grant.provider).baseUrl}/chat/completions`,
  };
}

async function claimGrant(
  context: Context,
  dependencies: AutomationModelBrokerDependencies,
  input: {
    model: string;
    provider: ModelProviderId;
    requestedMaxOutputTokens: number | null;
    token: string;
  },
): Promise<AutomationModelBrokerClaim | Response> {
  let grant: AutomationModelBrokerClaim | null;
  try {
    grant = await dependencies.claimGrant({
      model: input.model,
      provider: input.provider,
      requestedMaxOutputTokens: input.requestedMaxOutputTokens,
      tokenHash: automationModelBrokerTokenHash(input.token),
    });
  } catch (error) {
    logBrokerError("automation_model_broker_claim_failed", error);
    return context.json({ error: "Model broker is unavailable" }, 503);
  }
  return grant ?? context.json(
    { error: "Model broker grant is invalid or exhausted" },
    401,
  );
}

function releaseReservation(
  reservationId: string,
  grant: AutomationModelBrokerClaim,
  dependencies: AutomationModelBrokerDependencies,
): void {
  void dependencies.releaseInference(reservationId).catch((error: unknown) => {
    logBrokerError("automation_model_usage_release_failed", error, grant);
  });
}

async function forward(
  context: Context,
  format: AutomationModelWireFormat,
  grant: AutomationModelBrokerClaim,
  dependencies: AutomationModelBrokerDependencies,
  buildRequest: () => Promise<ProviderRequest>,
): Promise<Response> {
  let providerResponse: Response;
  let reservationId: string | undefined;
  try {
    const request = await buildRequest();
    reservationId = request.reservationId;
    providerResponse = await dependencies.providerFetch(request.url, {
      body: JSON.stringify(request.body),
      headers: request.headers,
      method: "POST",
      redirect: "error",
      // Responder-funded requests are not cancelled with the client, so the
      // full response can be metered. Organization-funded requests stop
      // when the client disconnects.
      signal: grant.inferenceSource === "responder"
        ? AbortSignal.timeout(providerRequestTimeoutMs)
        : AbortSignal.any([
            context.req.raw.signal,
            AbortSignal.timeout(providerRequestTimeoutMs),
          ]),
    });
  } catch (error) {
    if (reservationId) releaseReservation(reservationId, grant, dependencies);
    if (error instanceof BrokerRequestError) {
      return context.json({ error: error.message }, error.status);
    }
    logBrokerError("automation_model_provider_request_failed", error, grant);
    return context.json({ error: "Model provider request failed" }, 502);
  }
  // A failed provider response is not metered, so it releases its reservation.
  if (reservationId && !providerResponse.ok) {
    releaseReservation(reservationId, grant, dependencies);
    reservationId = undefined;
  }
  return brokerResponse(providerResponse, format, grant, dependencies, reservationId);
}

export function createAutomationModelBrokerRoutes(
  dependencies: AutomationModelBrokerDependencies = defaultDependencies,
) {
  return new Hono().post("/v1/providers/:provider/chat/completions", async (context) => {
    const provider = automationModelProviderSchema.safeParse(context.req.param("provider"));
    if (!provider.success || provider.data === "anthropic") {
      return context.json({ error: "Unsupported provider" }, 400);
    }
    const token = brokerToken(context);
    if (!token) return context.json({ error: "Unauthorized" }, 401);
    const body = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.model !== "string" || !modelIdentifierPattern.test(body.model) || !Array.isArray(body.messages)) {
      return context.json({ error: "Invalid model request" }, 400);
    }
    const limits = [body.max_tokens, body.max_completion_tokens].filter(value => value !== undefined && value !== null);
    if (limits.some(value => !Number.isSafeInteger(value) || (value as number) <= 0) || (body.n !== undefined && body.n !== 1)) {
      return context.json({ error: "Invalid model request limits" }, 400);
    }
    const grant = await claimGrant(context, dependencies, {
      model: body.model,
      provider: provider.data,
      requestedMaxOutputTokens: limits.length ? Math.max(...limits as number[]) : null,
      token,
    });
    if (grant instanceof Response) return grant;
    return forward(context, "chat_completions", grant, dependencies, () =>
      chatCompletionsProviderRequest(body, grant, dependencies));
  }).post("/v1/responses", async (context) => {
    const token = brokerToken(context);
    if (!token) return context.json({ error: "Unauthorized" }, 401);

    const parsed = parseResponsesRequest(
      await context.req.json().catch(() => null),
    );
    if (!parsed) {
      return context.json({ error: "Invalid model provider request" }, 400);
    }
    const grant = await claimGrant(context, dependencies, {
      model: parsed.model,
      provider: "openai",
      requestedMaxOutputTokens: parsed.requestedMaxOutputTokens,
      token,
    });
    if (grant instanceof Response) return grant;
    return forward(context, "responses", grant, dependencies, () =>
      openAIProviderRequest(parsed.body, grant, dependencies));
  }).post("/v1/messages", async (context) => {
    const token = brokerToken(context);
    if (!token) return context.json({ error: "Unauthorized" }, 401);

    const parsed = parseMessagesRequest(
      await context.req.json().catch(() => null),
    );
    if (!parsed) {
      return context.json({ error: "Invalid model provider request" }, 400);
    }
    const grant = await claimGrant(context, dependencies, {
      model: parsed.model,
      provider: "anthropic",
      requestedMaxOutputTokens: parsed.requestedMaxOutputTokens,
      token,
    });
    if (grant instanceof Response) return grant;
    return forward(context, "messages", grant, dependencies, () =>
      anthropicProviderRequest(context, parsed.body, grant, dependencies));
  });
}

export const automationModelBrokerRoutes = createAutomationModelBrokerRoutes();
