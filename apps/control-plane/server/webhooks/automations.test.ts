import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  automationAcceptsWebhook,
  AutomationConfigurationError,
} from "../../../../packages/core/src/db/automations.js";
import { automationWebhookToken } from "../../../../packages/core/src/integrations/webhook-secret.js";
import { queueAutomationRun } from "../automations/queue.js";
import { automationWebhookRoutes, automationWebhookTrigger } from "./automations.js";

vi.mock("../../../../packages/core/src/db/automations.js", () => ({
  automationAcceptsWebhook: vi.fn(),
  AutomationConfigurationError: class AutomationConfigurationError extends Error {
    constructor(message: string, readonly code: string) {
      super(message);
    }
  },
}));
vi.mock("../automations/queue.js", () => ({ queueAutomationRun: vi.fn() }));

const app = new Hono().route("/api/webhooks/automations", automationWebhookRoutes);
let automationId = "";
let sequence = 0;

function deliver(
  body: string,
  headers: Record<string, string> = {},
  id = automationId,
) {
  return app.request(`/api/webhooks/automations/${id}`, {
    body,
    headers: {
      authorization: `Bearer ${automationWebhookToken(id)}`,
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });
}

describe("automation webhooks", () => {
  beforeEach(() => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    // The rate limiter lives for the module, so each test uses its own
    // automation.
    sequence += 1;
    automationId = `20000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
    vi.mocked(automationAcceptsWebhook).mockResolvedValue(true);
    vi.mocked(queueAutomationRun).mockResolvedValue({ duplicate: false, runId: "run-1" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("starts a run with the request body as the trigger payload", async () => {
    const response = await deliver(JSON.stringify({ details: { errorRate: 0.12 }, title: "Checkout errors are up" }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ duplicate: false, ok: true, runId: "run-1" });
    expect(automationAcceptsWebhook).toHaveBeenCalledWith(automationId);
    expect(queueAutomationRun).toHaveBeenCalledWith({
      automationId,
      trigger: {
        attributes: { contentType: "application/json" },
        body: JSON.stringify({ details: { errorRate: 0.12 }, title: "Checkout errors are up" }, null, 2),
        externalEventId: expect.stringMatching(/^webhook:[0-9a-f-]{36}$/u),
        provider: "webhook",
        title: "Checkout errors are up",
      },
    });
  });

  it("starts one run per idempotency key", async () => {
    vi.mocked(queueAutomationRun).mockResolvedValueOnce({ duplicate: true, runId: "run-1" });
    const response = await deliver("{}", { "idempotency-key": "deploy-4821" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ duplicate: true, ok: true, runId: "run-1" });
    expect(vi.mocked(queueAutomationRun).mock.calls[0]![0].trigger.externalEventId).toBe("webhook:deploy-4821");
  });

  it("rejects a missing or wrong token without looking up the automation", async () => {
    for (const authorization of ["", "Bearer wrong", `Bearer ${automationWebhookToken("20000000-0000-4000-8000-999999999999")}`]) {
      const response = await deliver("{}", { authorization });
      expect(response.status).toBe(401);
    }
    const invalidId = await app.request("/api/webhooks/automations/not-a-uuid", { body: "{}", method: "POST" });
    expect(invalidId.status).toBe(401);
    expect(automationAcceptsWebhook).not.toHaveBeenCalled();
    expect(queueAutomationRun).not.toHaveBeenCalled();
  });

  it("does not start a run when the automation is off or has no webhook trigger", async () => {
    vi.mocked(automationAcceptsWebhook).mockResolvedValue(false);
    const response = await deliver("{}");

    expect(response.status).toBe(404);
    expect(queueAutomationRun).not.toHaveBeenCalled();
  });

  it("answers 404 when the automation is turned off while the run starts", async () => {
    vi.mocked(queueAutomationRun).mockRejectedValue(
      new AutomationConfigurationError("Automation is unavailable", "automation_not_found"),
    );
    expect((await deliver("{}")).status).toBe(404);
  });

  it("answers 503 when the run cannot be queued", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(queueAutomationRun).mockRejectedValue(new Error("Automation worker is unavailable"));
    expect((await deliver("{}")).status).toBe(503);
  });

  it("rejects an invalid idempotency key", async () => {
    const response = await deliver("{}", { "idempotency-key": "has spaces" });

    expect(response.status).toBe(400);
    expect(queueAutomationRun).not.toHaveBeenCalled();
  });

  it("limits each automation to 30 requests a minute", async () => {
    for (let request = 0; request < 30; request += 1) {
      expect((await deliver("{}")).status).toBe(202);
    }
    const limited = await deliver("{}");

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(queueAutomationRun).toHaveBeenCalledTimes(30);
  });
});

describe("automation webhook trigger", () => {
  it("passes text bodies on as they are", () => {
    expect(automationWebhookTrigger("Deploy 4821 failed")).toEqual({ body: "Deploy 4821 failed", title: "Webhook request" });
  });

  it("names the run from a JSON object's title only", () => {
    expect(automationWebhookTrigger("[1,2]").title).toBe("Webhook request");
    expect(automationWebhookTrigger(JSON.stringify({ title: "  " })).title).toBe("Webhook request");
    expect(automationWebhookTrigger(JSON.stringify({ title: "x".repeat(600) })).title).toHaveLength(500);
  });

  it("describes an empty body and shortens long ones", () => {
    expect(automationWebhookTrigger("").body).toBe("The request had no body.");
    expect(automationWebhookTrigger("x".repeat(200_000)).body).toHaveLength(100_000);
  });
});
