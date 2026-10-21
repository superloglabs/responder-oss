import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findAutomationsForSignozAlert } from "../../../../packages/core/src/db/automations.js";
import { getConnectedIntegrationAccountCredential } from "../../../../packages/core/src/db/integrations.js";
import { signozWebhookSecret } from "../../../../packages/core/src/integrations/signoz.js";
import { queueAutomationRun } from "../automations/queue.js";
import { signozWebhookRoutes } from "./signoz.js";

vi.mock("../../../../packages/core/src/db/automations.js", () => ({
  findAutomationsForSignozAlert: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/integrations.js", () => ({
  getConnectedIntegrationAccountCredential: vi.fn(),
}));
vi.mock("../automations/queue.js", () => ({ queueAutomationRun: vi.fn() }));

const accountId = "10000000-0000-4000-8000-000000000000";
const automationId = "20000000-0000-4000-8000-000000000000";
const app = new Hono().route("/api/webhooks/signoz", signozWebhookRoutes);

function signozAlert(overrides: Record<string, unknown> = {}) {
  return {
    status: "firing",
    labels: {
      alertname: "Checkout error rate",
      ruleId: "019a1b2c",
      ruleSource: "https://acme.us.signoz.cloud/alerts/edit?ruleId=019a1b2c",
      service_name: "checkout",
      severity: "critical",
    },
    annotations: {
      description: "Error rate is 12% for checkout",
      summary: "Checkout errors above 5%",
    },
    startsAt: "2026-10-21T09:15:00Z",
    endsAt: "0001-01-01T00:00:00Z",
    generatorURL: "https://acme.us.signoz.cloud/alerts/edit?ruleId=019a1b2c",
    fingerprint: "ad592b0afcbe2e79",
    ...overrides,
  };
}

function notification(alerts: unknown[] = [signozAlert()]) {
  return {
    receiver: "Responder",
    status: "firing",
    alerts,
    groupLabels: { alertname: "Checkout error rate" },
    commonLabels: { alertname: "Checkout error rate" },
    commonAnnotations: {},
    externalURL: "https://acme.us.signoz.cloud",
    version: "4",
    groupKey: "{}/{}:{alertname=\"Checkout error rate\"}",
    truncatedAlerts: 0,
  };
}

function deliver(body: unknown, authorization = `Bearer ${signozWebhookSecret(accountId)}`) {
  return app.request(`/api/webhooks/signoz/${accountId}`, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { authorization, "content-type": "application/json" },
    method: "POST",
  });
}

describe("SigNoz webhooks", () => {
  beforeEach(() => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.mocked(getConnectedIntegrationAccountCredential).mockResolvedValue({
      encryptedCredentials: "encrypted",
      metadata: {},
      organizationId: "organization-1",
    });
    vi.mocked(findAutomationsForSignozAlert).mockResolvedValue([{ automationId }]);
    vi.mocked(queueAutomationRun).mockResolvedValue({ duplicate: false, runId: "run" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("starts each automation watching the connection for a firing alert", async () => {
    vi.mocked(findAutomationsForSignozAlert).mockResolvedValue([
      { automationId },
      { automationId: "30000000-0000-4000-8000-000000000000" },
    ]);

    const response = await deliver(notification());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ matchedAutomations: 2, ok: true, startedAlerts: 1 });
    expect(findAutomationsForSignozAlert).toHaveBeenCalledWith(accountId);
    const calls = vi.mocked(queueAutomationRun).mock.calls.map(([input]) => input);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      automationId,
      trigger: {
        attributes: {
          alertName: "Checkout error rate",
          fingerprint: "ad592b0afcbe2e79",
          integrationAccountId: accountId,
          ruleId: "019a1b2c",
          severity: "critical",
          startsAt: "2026-10-21T09:15:00Z",
          status: "firing",
        },
        body: expect.any(String),
        externalEventId: `${accountId}:ad592b0afcbe2e79:2026-10-21T09:15:00Z`,
        provider: "signoz",
        sourceUrl: "https://acme.us.signoz.cloud/alerts/edit?ruleId=019a1b2c",
        title: "Checkout error rate: Checkout errors above 5%",
      },
    });
    expect(JSON.parse(calls[0]!.trigger.body)).toMatchObject({
      annotations: { description: "Error rate is 12% for checkout" },
      externalURL: "https://acme.us.signoz.cloud",
      labels: { service_name: "checkout" },
    });
  });

  it("gives a repeated notification of the same alert the same event ID", async () => {
    await deliver(notification());
    await deliver(notification([signozAlert(), signozAlert({ fingerprint: "b1c2d3e4f5a6b7c8" })]));
    await deliver(notification([signozAlert({ startsAt: "2026-10-21T11:00:00Z" })]));

    const ids = vi.mocked(queueAutomationRun).mock.calls.map(([input]) => input.trigger.externalEventId);
    expect(ids).toEqual([
      `${accountId}:ad592b0afcbe2e79:2026-10-21T09:15:00Z`,
      `${accountId}:ad592b0afcbe2e79:2026-10-21T09:15:00Z`,
      `${accountId}:b1c2d3e4f5a6b7c8:2026-10-21T09:15:00Z`,
      `${accountId}:ad592b0afcbe2e79:2026-10-21T11:00:00Z`,
    ]);
  });

  it("ignores resolved alerts", async () => {
    const response = await deliver(notification([
      signozAlert({ endsAt: "2026-10-21T09:30:00Z", status: "resolved" }),
    ]));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ignored: true, ok: true });
    expect(findAutomationsForSignozAlert).not.toHaveBeenCalled();
  });

  it("starts runs only for the firing alerts in a mixed delivery", async () => {
    await deliver(notification([
      signozAlert({ fingerprint: "resolved", status: "resolved" }),
      signozAlert(),
    ]));

    const ids = vi.mocked(queueAutomationRun).mock.calls.map(([input]) => input.trigger.externalEventId);
    expect(ids).toEqual([`${accountId}:ad592b0afcbe2e79:2026-10-21T09:15:00Z`]);
  });

  it("names an alert without a summary after its rule, and drops a link that is not HTTPS", async () => {
    await deliver(notification([signozAlert({ annotations: {}, generatorURL: "http://localhost:8080/alerts" })]));

    const trigger = vi.mocked(queueAutomationRun).mock.calls[0]![0].trigger;
    expect(trigger.title).toBe("Checkout error rate");
    expect(trigger).not.toHaveProperty("sourceUrl");
  });

  it("accepts the secret as a basic auth password", async () => {
    const credentials = Buffer.from(`responder:${signozWebhookSecret(accountId)}`).toString("base64");

    const response = await deliver(notification(), `Basic ${credentials}`);

    expect(response.status).toBe(200);
    expect(queueAutomationRun).toHaveBeenCalledTimes(1);
  });

  it("rejects a wrong secret and a secret for another connection", async () => {
    const wrong = await deliver(notification(), "Bearer not-the-secret");
    const wrongBasic = await deliver(notification(), `Basic ${Buffer.from("responder:nope").toString("base64")}`);
    const otherConnection = await deliver(
      notification(),
      `Bearer ${signozWebhookSecret("90000000-0000-4000-8000-000000000000")}`,
    );
    const missing = await deliver(notification(), "");

    expect([wrong.status, wrongBasic.status, otherConnection.status, missing.status]).toEqual([401, 401, 401, 401]);
    expect(findAutomationsForSignozAlert).not.toHaveBeenCalled();
  });

  it("rejects alerts for a connection that is not connected", async () => {
    vi.mocked(getConnectedIntegrationAccountCredential).mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof getConnectedIntegrationAccountCredential>>,
    );

    const response = await deliver(notification());

    expect(response.status).toBe(401);
    expect(findAutomationsForSignozAlert).not.toHaveBeenCalled();
  });

  it("reports a body that is not a SigNoz notification", async () => {
    const response = await deliver({ alerts: [{ status: "firing" }] });

    expect(response.status).toBe(400);
    expect(findAutomationsForSignozAlert).not.toHaveBeenCalled();
  });

  it("asks SigNoz to retry when a run cannot be queued", async () => {
    vi.mocked(queueAutomationRun).mockRejectedValue(new Error("queue down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await deliver(notification());

    expect(response.status).toBe(502);
  });
});
