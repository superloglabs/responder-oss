import { describe, expect, it, vi } from "vitest";
import { issueAutomationModelBrokerToken } from "../../../../packages/core/src/automations/model-broker.js";
import {
  anthropicMessagesEndpoint,
  createAutomationModelBrokerRoutes,
  openAIResponsesEndpoint,
} from "./model-broker.js";
import { app } from "../app.js";

const claim = {
  apiKey: "provider-secret",
  grantId: "21212121-2121-4121-8121-212121212121",
  maxOutputTokens: 4_096,
  model: "gpt-5.1-codex",
  organizationId: "15151515-1515-4515-8515-151515151515",
  runId: "run-1",
};

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
    const routes = createAutomationModelBrokerRoutes({
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
    expect(init.headers).toEqual({
      authorization: "Bearer provider-secret",
      "content-type": "application/json",
    });
    expect(init.headers.authorization).not.toContain(token);
    expect(JSON.parse(init.body)).toMatchObject({
      input: "Return a short acknowledgement.",
      max_output_tokens: 4_096,
      model: "gpt-5.1-codex",
      stream: true,
    });
  });

  it("fails closed without calling a provider when the grant is unavailable", async () => {
    const providerFetch = vi.fn();
    const routes = createAutomationModelBrokerRoutes({
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
    });
    const providerFetch = vi.fn().mockResolvedValue(
      Response.json({ content: [{ type: "text", text: "done" }] }, {
        headers: { "request-id": "anthropic-request-1" },
      }),
    );
    const routes = createAutomationModelBrokerRoutes({
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
    const routes = createAutomationModelBrokerRoutes({
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
    const providerFetch = vi.fn().mockRejectedValue(new Error("network failed"));
    const routes = createAutomationModelBrokerRoutes({
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
    const providerFetch = vi.fn().mockResolvedValue(
      Response.json(
        { error: { message: "Incorrect API key" } },
        { status: 401 },
      ),
    );
    const routes = createAutomationModelBrokerRoutes({
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
  ["google", "https://generativelanguage.googleapis.com/v1beta/openai"],
  ["xai", "https://api.x.ai/v1"],
  ["mistral", "https://api.mistral.ai/v1"],
  ["deepseek", "https://api.deepseek.com"],
  ["groq", "https://api.groq.com/openai/v1"],
])("routes %s chat requests through scoped grants and enforces output limits", async (provider, endpoint) => {
  const claimGrant = vi.fn().mockResolvedValue({ ...claim, model: "live-model" });
  const providerFetch = vi.fn().mockResolvedValue(new Response('data: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }));
  const broker = createAutomationModelBrokerRoutes({ claimGrant, providerFetch });
  const response = await broker.request(`/v1/providers/${provider}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${bearerToken()}`, "content-type": "application/json" }, body: JSON.stringify({ model: "live-model", messages: [{ role: "user", content: "hello" }], stream: true, max_completion_tokens: 500 }) });
  expect(response.status).toBe(200);
  expect(claimGrant).toHaveBeenCalledWith(expect.objectContaining({ provider, model: "live-model", requestedMaxOutputTokens: 500 }));
  expect(providerFetch).toHaveBeenCalledWith(`${endpoint}/chat/completions`, expect.objectContaining({ redirect: "error" }));
  const body = JSON.parse(providerFetch.mock.calls[0][1].body);
  expect(body.max_tokens).toBe(4096);
  expect(body.max_completion_tokens).toBeUndefined();
  expect(await response.text()).not.toContain("provider-secret");
});

it("rejects unsupported provider routes and multiple completion budget bypasses", async () => {
  const claimGrant = vi.fn(); const providerFetch = vi.fn();
  const broker = createAutomationModelBrokerRoutes({ claimGrant, providerFetch });
  const init = { method: "POST", headers: { authorization: `Bearer ${bearerToken()}`, "content-type": "application/json" }, body: JSON.stringify({ model: "model", messages: [], n: 2 }) };
  expect((await broker.request("/v1/providers/groq/chat/completions", init)).status).toBe(400);
  expect((await broker.request("/v1/providers/unknown/chat/completions", init)).status).toBe(400);
  expect(claimGrant).not.toHaveBeenCalled();
  expect(providerFetch).not.toHaveBeenCalled();
});
