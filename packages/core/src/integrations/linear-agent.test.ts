import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createLinearAgentActivity,
  linearAgentRequestBody,
  linearAgentSessionEventSchema,
  verifyLinearWebhook,
} from "./linear-agent.js";

const secret = "linear-webhook-secret";
const now = Date.parse("2026-10-02T12:00:00Z");

function sign(body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function event(overrides: Record<string, unknown> = {}) {
  return linearAgentSessionEventSchema.parse({
    type: "AgentSessionEvent",
    action: "created",
    organizationId: "linear-organization",
    webhookTimestamp: now,
    promptContext: "<issue identifier=\"ENG-1\">Checkout returns 503</issue>",
    agentSession: { id: "session-1" },
    ...overrides,
  });
}

describe("Linear webhook verification", () => {
  it("accepts a signed delivery from the last minute", () => {
    const body = JSON.stringify({ webhookTimestamp: now - 30_000 });

    expect(verifyLinearWebhook({ body, now, secret, signature: sign(body) }))
      .toBe(true);
  });

  it("rejects a wrong signature, a missing signature, and an old delivery", () => {
    const body = JSON.stringify({ webhookTimestamp: now });
    const old = JSON.stringify({ webhookTimestamp: now - 61_000 });

    expect(verifyLinearWebhook({ body, now, secret, signature: sign(old) }))
      .toBe(false);
    expect(verifyLinearWebhook({ body, now, secret, signature: undefined }))
      .toBe(false);
    expect(verifyLinearWebhook({ body: old, now, secret, signature: sign(old) }))
      .toBe(false);
  });
});

describe("Linear agent requests", () => {
  it("uses the prompt context for a new session and the message for a follow-up", () => {
    expect(linearAgentRequestBody(event())).toBe(
      "<issue identifier=\"ENG-1\">Checkout returns 503</issue>",
    );
    expect(
      linearAgentRequestBody(event({
        action: "prompted",
        agentActivity: {
          id: "activity-1",
          content: { type: "prompt", body: " Also open a PR. " },
        },
      })),
    ).toBe("Also open a PR.");
    expect(linearAgentRequestBody(event({ action: "updated" }))).toBeNull();
  });

  it("posts an activity to the agent session", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ data: { agentActivityCreate: { success: true } } }),
    );

    await createLinearAgentActivity({
      accessToken: "token",
      agentSessionId: "session-1",
      content: { type: "response", body: "Opened acme/api#12." },
      fetchImpl,
      id: "10000000-0000-4000-8000-000000000000",
    });

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
    expect(JSON.parse(String(init?.body)).variables).toEqual({
      input: {
        agentSessionId: "session-1",
        content: { type: "response", body: "Opened acme/api#12." },
        id: "10000000-0000-4000-8000-000000000000",
      },
    });
  });
});
