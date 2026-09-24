import { describe, expect, it, vi } from "vitest";
import { issueAutomationModelBrokerToken } from "../../../../packages/core/src/automations/model-broker.js";
import {
  aiGatewayChatCompletionsEndpoint,
  aiGatewayMessagesEndpoint,
  aiGatewayResponsesEndpoint,
  anthropicMessagesEndpoint,
  createAutomationModelBrokerRoutes,
  openAIResponsesEndpoint,
} from "./model-broker.js";
import { app } from "../app.js";

const claim = {
  apiKey: "provider-secret" as string | null,
  grantId: "21212121-2121-4121-8121-212121212121",
  inferenceSource: "byok" as "byok" | "byos" | "responder",
  maxOutputTokens: 4_096,
  model: "gpt-5.1-codex",
  organizationId: "15151515-1515-4515-8515-151515151515",
  provider: "openai" as string,
  runId: "run-1",
};

type BrokerDependencies = Parameters<typeof createAutomationModelBrokerRoutes>[0];

function brokerRoutes(overrides: Partial<NonNullable<BrokerDependencies>>) {
  return createAutomationModelBrokerRoutes({
    claimGrant: vi.fn(),
    completeInference: vi.fn().mockResolvedValue(undefined),
    gatewayApiKey: () => "gateway-secret",
    getPricing: vi.fn().mockResolvedValue({ input: "0.000001", output: "0.000002" }),
    providerFetch: vi.fn(),
    recordUsage: vi.fn().mockResolvedValue(undefined),
    releaseInference: vi.fn().mockResolvedValue(undefined),
    reserveInference: vi.fn().mockResolvedValue("reservation-1"),
    ...overrides,
  });
}

function bearerToken() {
  return issueAutomationModelBrokerToken(() => Buffer.alloc(32, 2)).token;
}

describe("automation model broker route", () => {
  it("is mounted on the public API boundary", async () => {
    const response = await app.request(
      "/api/automation-model-broker/v1/responses",
      { method: "POST" },
    );

    expect(response.status).toBe(401);
  });

  it("claims the scoped allowance and streams one direct provider response", async () => {
    const claimGrant = vi.fn().mockResolvedValue(claim);
    const providerFetch = vi.fn().mockResolvedValue(
      new Response('data: {"type":"response.completed"}\n\n', {
        headers: {
          "content-type": "text/event-stream",
          "x-request-id": "provider-request-1",
          "set-cookie": "must-not-be-forwarded=true",
        },
      }),
    );
    const routes = brokerRoutes({
      claimGrant,
      providerFetch,
    });
    const token = bearerToken();

    const response = await routes.request("/v1/responses", {
      body: JSON.stringify({
        input: "Return a short acknowledgement.",
        model: "gpt-5.1-codex",
        stream: true,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-request-id")).toBe("provider-request-1");
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.text()).resolves.toBe(
      'data: {"type":"response.completed"}\n\n',
    );
    expect(claimGrant).toHaveBeenCalledWith({
      model: "gpt-5.1-codex",
      provider: "openai",
      requestedMaxOutputTokens: null,
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(claimGrant.mock.calls[0]![0].tokenHash).not.toBe(token);
    expect(providerFetch).toHaveBeenCalledOnce();
    const [url, init] = providerFetch.mock.calls[0]!;
    expect(url).toBe(openAIResponsesEndpoint);
    expect(Object.fromEntries(init.headers)).toEqual({
      authorization: "Bearer provider-secret",
      "content-type": "application/json",
    });
    expect(init.headers.get("authorization")).not.toContain(token);
    expect(JSON.parse(init.body)).toMatchObject({
      input: "Return a short acknowledgement.",
      max_output_tokens: 4_096,
      model: "gpt-5.1-codex",
      stream: true,
    });
  });

  it("fails closed without calling a provider when the grant is unavailable", async () => {
    const providerFetch = vi.fn();
    const routes = brokerRoutes({
      claimGrant: vi.fn().mockResolvedValue(null),
      providerFetch,
    });

    const response = await routes.request("/v1/responses", {
      body: JSON.stringify({ model: "gpt-5.1-codex", input: "hello" }),
      headers: {
        authorization: `Bearer ${bearerToken()}`,
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Model broker grant is invalid or exhausted",
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("proxies Anthropic messages with the provider key kept server-side", async () => {
    const claimGrant = vi.fn().mockResolvedValue({
      ...claim,
      model: "claude-sonnet-4-5",
      provider: "anthropic",
    });
    const providerFetch = vi.fn().mockResolvedValue(
      Response.json(
        { content: [{ type: "text", text: "done" }] },
        {
          headers: { "request-id": "anthropic-request-1" },
        },
      ),
    );
    const routes = brokerRoutes({
      claimGrant,
      providerFetch,
    });
    const token = bearerToken();

    const response = await routes.request("/v1/messages", {
      body: JSON.stringify({
        max_tokens: 8_000,
        messages: [{ role: "user", content: "hello" }],
        model: "claude-sonnet-4-5",
      }),
      headers: {
        "anthropic-beta": "context-1m-2025-08-07",
        "content-type": "application/json",
        "x-api-key": token,
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("request-id")).toBe("anthropic-request-1");
    expect(claimGrant).toHaveBeenCalledWith({
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      requestedMaxOutputTokens: 8_000,
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const [url, init] = providerFetch.mock.calls[0]!;
    expect(url).toBe(anthropicMessagesEndpoint);
    expect(init.headers.get("x-api-key")).toBe("provider-secret");
    expect(init.headers.get("x-api-key")).not.toBe(token);
    expect(init.headers.get("anthropic-beta")).toBe("context-1m-2025-08-07");
    expect(JSON.parse(init.body)).toMatchObject({
      max_tokens: 4_096,
      model: "claude-sonnet-4-5",
    });
  });

  it("rejects malformed tokens and requests before spending an allowance", async () => {
    const claimGrant = vi.fn();
    const providerFetch = vi.fn();
    const routes = brokerRoutes({
      claimGrant,
      providerFetch,
    });

    const unauthorized = await routes.request("/v1/responses", {
      body: JSON.stringify({ model: "gpt-5.1-codex", input: "hello" }),
      headers: { authorization: "Bearer invalid" },
      method: "POST",
    });
    const invalidBody = await routes.request("/v1/responses", {
      body: JSON.stringify({
        background: true,
        max_output_tokens: -1,
        model: "gpt-5.1-codex",
      }),
      headers: {
        authorization: `Bearer ${bearerToken()}`,
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(unauthorized.status).toBe(401);
    expect(invalidBody.status).toBe(400);
    expect(claimGrant).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("does not retry or fall back when the selected provider is unavailable", async () => {
    const providerFetch = vi
      .fn()
      .mockRejectedValue(new Error("network failed"));
    const routes = brokerRoutes({
      claimGrant: vi.fn().mockResolvedValue(claim),
      providerFetch,
    });

    const response = await routes.request("/v1/responses", {
      body: JSON.stringify({ model: "gpt-5.1-codex", input: "hello" }),
      headers: {
        authorization: `Bearer ${bearerToken()}`,
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Model provider request failed",
    });
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it("returns provider authentication failures without substituting credentials", async () => {
    const providerFetch = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: { message: "Incorrect API key" } },
          { status: 401 },
        ),
      );
    const routes = brokerRoutes({
      claimGrant: vi.fn().mockResolvedValue(claim),
      providerFetch,
    });

    const response = await routes.request("/v1/responses", {
      body: JSON.stringify({ model: "gpt-5.1-codex", input: "hello" }),
      headers: {
        authorization: `Bearer ${bearerToken()}`,
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Incorrect API key" },
    });
    expect(providerFetch).toHaveBeenCalledOnce();
  });
});

it.each([
  ["openai", "https://api.openai.com/v1"],
  ["google", "https://generativelanguage.googleapis.com/v1beta/openai"],
  ["xai", "https://api.x.ai/v1"],
  ["mistral", "https://api.mistral.ai/v1"],
  ["deepseek", "https://api.deepseek.com"],
])(
  "routes %s chat requests through scoped grants and enforces output limits",
  async (provider, endpoint) => {
    const claimGrant = vi
      .fn()
      .mockResolvedValue({ ...claim, model: "live-model", provider });
    const providerFetch = vi
      .fn()
      .mockResolvedValue(
        new Response("data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
      );
    const broker = brokerRoutes({
      claimGrant,
      providerFetch,
    });
    const response = await broker.request(
      `/v1/providers/${provider}/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearerToken()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "live-model",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
          max_completion_tokens: 500,
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(claimGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        provider,
        model: "live-model",
        requestedMaxOutputTokens: 500,
      }),
    );
    expect(providerFetch).toHaveBeenCalledWith(
      `${endpoint}/chat/completions`,
      expect.objectContaining({ redirect: "error" }),
    );
    const body = JSON.parse(providerFetch.mock.calls[0][1].body);
    expect(body[provider === "openai" ? "max_completion_tokens" : "max_tokens"]).toBe(4096);
    expect(body[provider === "openai" ? "max_tokens" : "max_completion_tokens"]).toBeUndefined();
    expect(await response.text()).not.toContain("provider-secret");
  },
);

it("rejects unsupported provider routes and multiple completion budget bypasses", async () => {
  const claimGrant = vi.fn();
  const providerFetch = vi.fn();
  const broker = brokerRoutes({
    claimGrant,
    providerFetch,
  });
  const init = {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearerToken()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "model", messages: [], n: 2 }),
  };
  expect(
    (await broker.request("/v1/providers/deepseek/chat/completions", init)).status,
  ).toBe(400);
  expect(
    (await broker.request("/v1/providers/unknown/chat/completions", init))
      .status,
  ).toBe(400);
  expect(claimGrant).not.toHaveBeenCalled();
  expect(providerFetch).not.toHaveBeenCalled();
});

describe("Responder-funded automation inference", () => {
  it("routes Responder-funded requests through AI Gateway and records usage", async () => {
    const completeInference = vi.fn().mockResolvedValue(undefined);
    const reserveInference = vi.fn().mockResolvedValue("reservation-1");
    const providerFetch = vi.fn().mockResolvedValue(
      new Response(
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":400},"output_tokens":50}}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    const routes = brokerRoutes({
      claimGrant: vi.fn().mockResolvedValue({
        ...claim,
        apiKey: null,
        inferenceSource: "responder",
        model: "gpt-5.4",
      }),
      providerFetch,
      completeInference,
      reserveInference,
    });

    const response = await routes.request("/v1/responses", {
      body: JSON.stringify({ input: "hello", model: "gpt-5.4", stream: true }),
      headers: {
        authorization: `Bearer ${bearerToken()}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    await response.text();
    await vi.waitFor(() => expect(completeInference).toHaveBeenCalledOnce());

    // The reservation holds an estimated maximum cost for this request.
    expect(reserveInference).toHaveBeenCalledWith({
      estimateMicros: expect.any(Number),
      model: "gpt-5.4",
      organizationId: claim.organizationId,
      provider: "openai",
      runId: "run-1",
    });
    expect(reserveInference.mock.calls[0]![0].estimateMicros).toBeGreaterThanOrEqual(8_192);
    const [url, init] = providerFetch.mock.calls[0]!;
    expect(url).toBe(aiGatewayResponsesEndpoint);
    expect(init.headers.get("authorization")).toBe("Bearer gateway-secret");
    expect(JSON.parse(init.body)).toMatchObject({
      max_output_tokens: 4_096,
      model: "openai/gpt-5.4",
    });
    expect(completeInference).toHaveBeenCalledWith({
      model: "gpt-5.4",
      provider: "openai",
      reservationId: "reservation-1",
      usage: {
        cacheWriteTokens: 0,
        cachedInputTokens: 400,
        inputTokens: 600,
        outputTokens: 50,
      },
    });
  });

  it("stops Responder-funded requests when the allowance is used up", async () => {
    const providerFetch = vi.fn();
    const routes = brokerRoutes({
      reserveInference: vi.fn().mockResolvedValue(null),
      claimGrant: vi.fn().mockResolvedValue({
        ...claim,
        apiKey: null,
        inferenceSource: "responder",
      }),
      providerFetch,
    });

    const response = await routes.request("/v1/responses", {
      body: JSON.stringify({ input: "hello", model: "gpt-5.1-codex" }),
      headers: {
        authorization: `Bearer ${bearerToken()}`,
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(402);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("fails Responder-funded requests when AI Gateway is not configured", async () => {
    const providerFetch = vi.fn();
    const routes = brokerRoutes({
      claimGrant: vi.fn().mockResolvedValue({
        ...claim,
        apiKey: null,
        inferenceSource: "responder",
      }),
      gatewayApiKey: () => undefined,
      providerFetch,
    });

    const response = await routes.request("/v1/responses", {
      body: JSON.stringify({ input: "hello", model: "gpt-5.1-codex" }),
      headers: {
        authorization: `Bearer ${bearerToken()}`,
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(503);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("sends Responder-funded Anthropic requests to AI Gateway with a gateway slug", async () => {
    const providerFetch = vi.fn().mockResolvedValue(
      Response.json({ usage: { input_tokens: 10, output_tokens: 2 } }),
    );
    const routes = brokerRoutes({
      claimGrant: vi.fn().mockResolvedValue({
        ...claim,
        apiKey: null,
        inferenceSource: "responder",
        model: "claude-sonnet-4-5",
        provider: "anthropic",
      }),
      providerFetch,
    });

    const response = await routes.request("/v1/messages", {
      body: JSON.stringify({
        max_tokens: 1_000,
        messages: [{ content: "hello", role: "user" }],
        model: "claude-sonnet-4-5",
      }),
      headers: {
        "content-type": "application/json",
        "x-api-key": bearerToken(),
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const [url, init] = providerFetch.mock.calls[0]!;
    expect(url).toBe(aiGatewayMessagesEndpoint);
    expect(init.headers.get("authorization")).toBe("Bearer gateway-secret");
    expect(init.headers.get("x-api-key")).toBeNull();
    expect(JSON.parse(init.body).model).toBe("anthropic/claude-sonnet-4.5");
  });

  it("refuses included usage for a model without gateway pricing", async () => {
    const providerFetch = vi.fn();
    const routes = brokerRoutes({
      claimGrant: vi.fn().mockResolvedValue({
        ...claim,
        apiKey: null,
        inferenceSource: "responder",
      }),
      getPricing: vi.fn().mockResolvedValue(null),
      providerFetch,
    });

    const response = await routes.request("/v1/responses", {
      body: JSON.stringify({ input: "hello", model: "gpt-5.1-codex" }),
      headers: {
        authorization: `Bearer ${bearerToken()}`,
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(409);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("keeps reading a Responder-funded stream after the client disconnects", async () => {
    const completeInference = vi.fn().mockResolvedValue(undefined);
    let push: (text: string) => void = () => undefined;
    let close: () => void = () => undefined;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => controller.enqueue(new TextEncoder().encode(text));
        close = () => controller.close();
      },
    });
    const providerFetch = vi.fn().mockResolvedValue(new Response(upstream, {
      headers: { "content-type": "text/event-stream" },
    }));
    const routes = brokerRoutes({
      claimGrant: vi.fn().mockResolvedValue({
        ...claim,
        apiKey: null,
        inferenceSource: "responder",
      }),
      providerFetch,
      completeInference,
    });

    const response = await routes.request("/v1/responses", {
      body: JSON.stringify({ input: "hello", model: "gpt-5.1-codex", stream: true }),
      headers: {
        authorization: `Bearer ${bearerToken()}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    push('data: {"type":"response.output_text.delta"}\n\n');
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(completeInference).not.toHaveBeenCalled();

    push('data: {"type":"response.completed","response":{"usage":{"input_tokens":9,"output_tokens":3}}}\n\n');
    close();
    await vi.waitFor(() => expect(completeInference).toHaveBeenCalledOnce());
    expect(completeInference.mock.calls[0]![0].usage).toMatchObject({
      inputTokens: 9,
      outputTokens: 3,
    });
    expect(providerFetch.mock.calls[0]![1].signal).toBeDefined();
  });

  it("sends Responder-funded chat completions to AI Gateway and asks for usage", async () => {
    const completeInference = vi.fn().mockResolvedValue(undefined);
    const providerFetch = vi.fn().mockResolvedValue(new Response(
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ));
    const routes = brokerRoutes({
      claimGrant: vi.fn().mockResolvedValue({
        ...claim,
        apiKey: null,
        inferenceSource: "responder",
        model: "grok-5",
        provider: "xai",
      }),
      providerFetch,
      completeInference,
    });

    const response = await routes.request("/v1/providers/xai/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "grok-5",
        stream: true,
      }),
      headers: {
        authorization: `Bearer ${bearerToken()}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    await response.text();
    await vi.waitFor(() => expect(completeInference).toHaveBeenCalledOnce());

    const [url, init] = providerFetch.mock.calls[0]!;
    expect(url).toBe(aiGatewayChatCompletionsEndpoint);
    expect(init.headers.get("authorization")).toBe("Bearer gateway-secret");
    expect(JSON.parse(init.body)).toMatchObject({
      max_tokens: 4_096,
      model: "spacexai/grok-5",
      stream_options: { include_usage: true },
    });
    expect(completeInference.mock.calls[0]![0]).toMatchObject({
      provider: "xai",
      usage: { inputTokens: 12, outputTokens: 3 },
    });
  });

  it("releases the reservation when the provider request fails", async () => {
    const releaseInference = vi.fn().mockResolvedValue(undefined);
    const completeInference = vi.fn();
    const routes = brokerRoutes({
      claimGrant: vi.fn().mockResolvedValue({
        ...claim,
        apiKey: null,
        inferenceSource: "responder",
      }),
      completeInference,
      providerFetch: vi.fn().mockResolvedValue(Response.json({ error: "overloaded" }, { status: 529 })),
      releaseInference,
    });

    const response = await routes.request("/v1/responses", {
      body: JSON.stringify({ input: "hello", model: "gpt-5.1-codex" }),
      headers: {
        authorization: `Bearer ${bearerToken()}`,
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(529);
    expect(releaseInference).toHaveBeenCalledWith("reservation-1");
    expect(completeInference).not.toHaveBeenCalled();
  });
});
