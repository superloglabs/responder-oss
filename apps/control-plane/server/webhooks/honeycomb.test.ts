import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findAutomationsForHoneycombAlert } from "../../../../packages/core/src/db/automations.js";
import { getConnectedIntegrationAccountCredential } from "../../../../packages/core/src/db/integrations.js";
import { honeycombWebhookSecret } from "../../../../packages/core/src/integrations/honeycomb.js";
import { queueAutomationRun } from "../automations/queue.js";
import { honeycombWebhookRoutes } from "./honeycomb.js";

vi.mock("../../../../packages/core/src/db/automations.js", () => ({
  findAutomationsForHoneycombAlert: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/integrations.js", () => ({
  getConnectedIntegrationAccountCredential: vi.fn(),
}));
vi.mock("../automations/queue.js", () => ({ queueAutomationRun: vi.fn() }));

const accountId = "10000000-0000-4000-8000-000000000000";
const automationId = "20000000-0000-4000-8000-000000000000";
const app = new Hono().route("/api/webhooks/honeycomb", honeycombWebhookRoutes);

// Honeycomb's default trigger webhook body.
function triggerAlert(overrides: Record<string, unknown> = {}) {
  return {
    version: "v0.1.0",
    shared_secret: "",
    name: "Checkout errors",
    id: "kQjkatCVK6M",
    trigger_description: "Runbook: check the payment provider first",
    status: "TRIGGERED",
    summary: "Triggered: Checkout errors",
    description: "Currently greater than threshold value (5) for service.name:checkout (value 12)",
    operator: "greater than",
    threshold: 5,
    result_url: "https://ui.honeycomb.io/acme/environments/production/datasets/api/result/p3o2dvAhYxx",
    result_groups: [{ Group: { "service.name": "checkout" }, Result: 12 }],
    result_groups_triggered: [{ Group: { "service.name": "checkout" }, Result: 12 }],
    trigger_url: "https://ui.honeycomb.io/acme/environments/production/datasets/api/triggers/kQjkatCVK6M",
    is_test: false,
    ...overrides,
  };
}

function deliver(
  body: unknown,
  headers: Record<string, string> = {
    "x-honeycomb-webhook-delivery-id": "delivery-1",
    "x-honeycomb-webhook-token": honeycombWebhookSecret(accountId),
  },
) {
  return app.request(`/api/webhooks/honeycomb/${accountId}`, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

describe("Honeycomb webhooks", () => {
  beforeEach(() => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.mocked(getConnectedIntegrationAccountCredential).mockResolvedValue({
      encryptedCredentials: "encrypted",
      metadata: {},
      organizationId: "organization-1",
    });
    vi.mocked(findAutomationsForHoneycombAlert).mockResolvedValue([{ automationId }]);
    vi.mocked(queueAutomationRun).mockResolvedValue({ duplicate: false, runId: "run" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("starts each automation watching the connection when a trigger fires", async () => {
    vi.mocked(findAutomationsForHoneycombAlert).mockResolvedValue([
      { automationId },
      { automationId: "30000000-0000-4000-8000-000000000000" },
    ]);

    const response = await deliver(triggerAlert({ shared_secret: "leaked" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ matchedAutomations: 2, ok: true });
    expect(findAutomationsForHoneycombAlert).toHaveBeenCalledWith(accountId);
    const calls = vi.mocked(queueAutomationRun).mock.calls.map(([input]) => input);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      automationId,
      trigger: {
        attributes: {
          alertId: "kQjkatCVK6M",
          alertName: "Checkout errors",
          integrationAccountId: accountId,
          operator: "greater than",
          status: "TRIGGERED",
          threshold: 5,
        },
        body: expect.any(String),
        externalEventId: `${accountId}:kQjkatCVK6M:delivery-1`,
        provider: "honeycomb",
        sourceUrl: "https://ui.honeycomb.io/acme/environments/production/datasets/api/result/p3o2dvAhYxx",
        title: "Triggered: Checkout errors",
      },
    });
    const body = JSON.parse(calls[0]!.trigger.body);
    expect(body).toMatchObject({
      result_groups_triggered: [{ Group: { "service.name": "checkout" }, Result: 12 }],
      trigger_description: "Runbook: check the payment provider first",
    });
    expect(body).not.toHaveProperty("shared_secret");
  });

  it("gives a retried delivery the same event ID and a new firing a new one", async () => {
    await deliver(triggerAlert());
    await deliver(triggerAlert());
    await deliver(triggerAlert(), {
      "x-honeycomb-webhook-delivery-id": "delivery-2",
      "x-honeycomb-webhook-token": honeycombWebhookSecret(accountId),
    });

    const ids = vi.mocked(queueAutomationRun).mock.calls.map(([input]) => input.trigger.externalEventId);
    expect(ids).toEqual([
      `${accountId}:kQjkatCVK6M:delivery-1`,
      `${accountId}:kQjkatCVK6M:delivery-1`,
      `${accountId}:kQjkatCVK6M:delivery-2`,
    ]);
  });

  it("identifies a delivery without a delivery ID by its body", async () => {
    const headers = { "x-honeycomb-webhook-token": honeycombWebhookSecret(accountId) };
    await deliver(triggerAlert(), headers);
    await deliver(triggerAlert(), headers);
    await deliver(triggerAlert({ result_url: "https://ui.honeycomb.io/acme/result/other" }), headers);

    const ids = vi.mocked(queueAutomationRun).mock.calls.map(([input]) => input.trigger.externalEventId);
    expect(ids[0]).toMatch(new RegExp(`^${accountId}:kQjkatCVK6M:[0-9a-f]{64}$`, "u"));
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("starts a run for an SLO burn alert", async () => {
    await deliver({
      id: "burn-1",
      is_test: false,
      name: "Checkout availability",
      slo_url: "https://ui.honeycomb.io/acme/environments/production/datasets/api/slo/abc",
      status: "TRIGGERED",
      summary: "Budget will be exhausted in 4 hours",
      version: "v0.1.0",
    });

    const trigger = vi.mocked(queueAutomationRun).mock.calls[0]![0].trigger;
    expect(trigger.title).toBe("Budget will be exhausted in 4 hours");
    expect(trigger.sourceUrl).toBe("https://ui.honeycomb.io/acme/environments/production/datasets/api/slo/abc");
  });

  it("ignores resolved alerts and test notifications", async () => {
    const resolved = await deliver(triggerAlert({ result_groups_triggered: [], status: "OK", summary: "Resolved: Checkout errors" }));
    const test = await deliver(triggerAlert({ is_test: true, summary: "TRIGGER TEST: Triggered: Checkout errors" }));

    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toEqual({ ignored: true, ok: true });
    expect(test.status).toBe(200);
    expect(await test.json()).toEqual({ ignored: true, ok: true });
    expect(findAutomationsForHoneycombAlert).not.toHaveBeenCalled();
  });

  it("names an alert without a summary after the trigger, and drops a link that is not HTTPS", async () => {
    await deliver(triggerAlert({ result_url: "http://localhost/result", summary: undefined, trigger_url: undefined }));

    const trigger = vi.mocked(queueAutomationRun).mock.calls[0]![0].trigger;
    expect(trigger.title).toBe("Checkout errors");
    expect(trigger).not.toHaveProperty("sourceUrl");
  });

  it("rejects a wrong token and a token for another connection", async () => {
    const wrong = await deliver(triggerAlert(), { "x-honeycomb-webhook-token": "not-the-secret" });
    const otherConnection = await deliver(triggerAlert(), {
      "x-honeycomb-webhook-token": honeycombWebhookSecret("90000000-0000-4000-8000-000000000000"),
    });
    const missing = await deliver(triggerAlert(), {});

    expect([wrong.status, otherConnection.status, missing.status]).toEqual([401, 401, 401]);
    expect(findAutomationsForHoneycombAlert).not.toHaveBeenCalled();
  });

  it("rejects alerts for a connection that is not connected", async () => {
    vi.mocked(getConnectedIntegrationAccountCredential).mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof getConnectedIntegrationAccountCredential>>,
    );

    const response = await deliver(triggerAlert());

    expect(response.status).toBe(401);
    expect(findAutomationsForHoneycombAlert).not.toHaveBeenCalled();
  });

  it("reports a body that is not a Honeycomb alert", async () => {
    const response = await deliver({ status: "TRIGGERED" });

    expect(response.status).toBe(400);
    expect(findAutomationsForHoneycombAlert).not.toHaveBeenCalled();
  });

  it("asks Honeycomb to retry when a run cannot be queued", async () => {
    vi.mocked(queueAutomationRun).mockRejectedValue(new Error("queue down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await deliver(triggerAlert());

    expect(response.status).toBe(502);
  });
});
