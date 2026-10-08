import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findAutomationsForAxiomAlert } from "../../../../packages/core/src/db/automations.js";
import { getConnectedIntegrationAccountCredential } from "../../../../packages/core/src/db/integrations.js";
import { axiomWebhookSecret } from "../../../../packages/core/src/integrations/axiom.js";
import { queueAutomationRun } from "../automations/queue.js";
import { axiomWebhookRoutes } from "./axiom.js";

vi.mock("../../../../packages/core/src/db/automations.js", () => ({
  findAutomationsForAxiomAlert: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/integrations.js", () => ({
  getConnectedIntegrationAccountCredential: vi.fn(),
}));
vi.mock("../automations/queue.js", () => ({ queueAutomationRun: vi.fn() }));

const accountId = "10000000-0000-4000-8000-000000000000";
const app = new Hono().route("/api/webhooks/axiom", axiomWebhookRoutes);

function alert(action = "Open") {
  return {
    action,
    event: {
      monitorID: "CabI3w142069etTgd0",
      title: "Checkout errors above threshold",
      description: "",
      body: "Current value of 57 is above or equal to the threshold value of 10",
      queryStartTime: "2026-10-08 14:45:57.631364493 +0000 UTC",
      queryEndTime: "2026-10-08 14:55:57.631364493 +0000 UTC",
      timestamp: "2026-10-08 14:55:57 +0000 UTC",
      value: 57,
      matchedEvent: null,
      groupKeys: ["service"],
      groupValues: ["checkout"],
    },
  };
}

function deliver(body: unknown, authorization = `Bearer ${axiomWebhookSecret(accountId)}`) {
  return app.request(`/api/webhooks/axiom/${accountId}`, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { authorization, "content-type": "application/json" },
    method: "POST",
  });
}

describe("Axiom webhooks", () => {
  beforeEach(() => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.mocked(getConnectedIntegrationAccountCredential).mockResolvedValue({
      encryptedCredentials: "encrypted",
      organizationId: "organization-1",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("starts each automation watching the connection with a retry-safe event ID", async () => {
    vi.mocked(findAutomationsForAxiomAlert).mockResolvedValue([
      { automationId: "20000000-0000-4000-8000-000000000000" },
      { automationId: "30000000-0000-4000-8000-000000000000" },
    ]);
    vi.mocked(queueAutomationRun).mockResolvedValue({ duplicate: false, runId: "run" });

    const first = await deliver(alert());
    const retry = await deliver(alert());

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ matchedAutomations: 2, ok: true });
    expect(retry.status).toBe(200);
    expect(findAutomationsForAxiomAlert).toHaveBeenCalledWith(accountId);
    const calls = vi.mocked(queueAutomationRun).mock.calls.map(([input]) => input);
    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatchObject({
      automationId: "20000000-0000-4000-8000-000000000000",
      trigger: {
        attributes: {
          action: "Open",
          integrationAccountId: accountId,
          monitorId: "CabI3w142069etTgd0",
          value: 57,
        },
        provider: "axiom",
        title: "Checkout errors above threshold",
      },
    });
    expect(JSON.parse(calls[0]!.trigger.body)).toMatchObject({ groupValues: ["checkout"] });
    expect(calls[0]!.trigger.externalEventId).toMatch(
      new RegExp(`^${accountId}:CabI3w142069etTgd0:[0-9a-f]{64}$`, "u"),
    );
    expect(calls[2]!.trigger.externalEventId).toBe(calls[0]!.trigger.externalEventId);
  });

  it("identifies an alert by its content, not by how the body is formatted", async () => {
    vi.mocked(findAutomationsForAxiomAlert).mockResolvedValue([
      { automationId: "20000000-0000-4000-8000-000000000000" },
    ]);
    vi.mocked(queueAutomationRun).mockResolvedValue({ duplicate: false, runId: "run" });

    await deliver(alert());
    await deliver(JSON.stringify(alert(), null, 2));
    await deliver({ ...alert(), event: { ...alert().event, groupValues: ["payments"] } });

    const ids = vi.mocked(queueAutomationRun).mock.calls.map(([input]) => input.trigger.externalEventId);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("names an untitled alert after its monitor", async () => {
    vi.mocked(findAutomationsForAxiomAlert).mockResolvedValue([
      { automationId: "20000000-0000-4000-8000-000000000000" },
    ]);
    vi.mocked(queueAutomationRun).mockResolvedValue({ duplicate: false, runId: "run" });
    const event: Partial<ReturnType<typeof alert>["event"]> = alert().event;
    delete event.title;

    await deliver({ action: "Open", event });

    expect(vi.mocked(queueAutomationRun).mock.calls[0]![0].trigger.title)
      .toBe("Axiom monitor CabI3w142069etTgd0");
  });

  it("ignores a monitor that recovers", async () => {
    const response = await deliver(alert("Closed"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ignored: true, ok: true });
    expect(findAutomationsForAxiomAlert).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret and a secret for another connection", async () => {
    const wrong = await deliver(alert(), "Bearer not-the-secret");
    const otherConnection = await deliver(
      alert(),
      `Bearer ${axiomWebhookSecret("90000000-0000-4000-8000-000000000000")}`,
    );

    expect(wrong.status).toBe(401);
    expect(otherConnection.status).toBe(401);
    expect(findAutomationsForAxiomAlert).not.toHaveBeenCalled();
  });

  it("rejects alerts for a connection that is not connected", async () => {
    vi.mocked(getConnectedIntegrationAccountCredential).mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof getConnectedIntegrationAccountCredential>>,
    );

    const response = await deliver(alert());

    expect(response.status).toBe(401);
    expect(findAutomationsForAxiomAlert).not.toHaveBeenCalled();
  });

  it("reports a body that is not an Axiom alert", async () => {
    const response = await deliver('{"action":"Open","event":{"body":"unquoted "text""}}');

    expect(response.status).toBe(400);
    expect(findAutomationsForAxiomAlert).not.toHaveBeenCalled();
  });

  it("asks Axiom to retry when a run cannot be queued", async () => {
    vi.mocked(findAutomationsForAxiomAlert).mockResolvedValue([
      { automationId: "20000000-0000-4000-8000-000000000000" },
    ]);
    vi.mocked(queueAutomationRun).mockRejectedValue(new Error("queue down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await deliver(alert());

    expect(response.status).toBe(502);
  });
});
