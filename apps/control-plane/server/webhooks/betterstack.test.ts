import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findAutomationsForBetterStackIncident } from "../../../../packages/core/src/db/automations.js";
import { getConnectedIntegrationAccountCredential } from "../../../../packages/core/src/db/integrations.js";
import { betterStackWebhookSecret } from "../../../../packages/core/src/integrations/betterstack.js";
import { queueAutomationRun } from "../automations/queue.js";
import { betterStackWebhookRoutes } from "./betterstack.js";

vi.mock("../../../../packages/core/src/db/automations.js", () => ({
  findAutomationsForBetterStackIncident: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/integrations.js", () => ({
  getConnectedIntegrationAccountCredential: vi.fn(),
}));
vi.mock("../automations/queue.js", () => ({ queueAutomationRun: vi.fn() }));

const accountId = "10000000-0000-4000-8000-000000000000";
const automationId = "20000000-0000-4000-8000-000000000000";
const app = new Hono().route("/api/webhooks/betterstack", betterStackWebhookRoutes);

// Better Stack's default incident webhook body.
function incident(attributes: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    data: {
      attributes: {
        acknowledged_at: null,
        cause: "Status 500",
        http_method: "get",
        name: "Checkout API",
        resolved_at: null,
        response_content: "Internal Server Error",
        response_url: null,
        screenshot_url: null,
        started_at: "2026-10-22T10:51:28.151Z",
        url: "https://api.acme.example/health",
        ...attributes,
      },
      id: "987654",
      relationships: { monitor: { data: { id: "4321", type: "monitor" } } },
      type: "incident",
    },
    ...extra,
  };
}

function basic(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function deliver(
  body: unknown,
  headers: Record<string, string> = { authorization: basic("responder", betterStackWebhookSecret(accountId)) },
) {
  return app.request(`/api/webhooks/betterstack/${accountId}`, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

describe("Better Stack webhooks", () => {
  beforeEach(() => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.mocked(getConnectedIntegrationAccountCredential).mockResolvedValue({
      encryptedCredentials: "encrypted",
      metadata: {},
      organizationId: "organization-1",
    });
    vi.mocked(findAutomationsForBetterStackIncident).mockResolvedValue([{ automationId }]);
    vi.mocked(queueAutomationRun).mockResolvedValue({ duplicate: false, runId: "run" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("starts each automation watching the connection when an incident starts", async () => {
    vi.mocked(findAutomationsForBetterStackIncident).mockResolvedValue([
      { automationId },
      { automationId: "30000000-0000-4000-8000-000000000000" },
    ]);

    const response = await deliver(incident());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ matchedAutomations: 2, ok: true });
    expect(findAutomationsForBetterStackIncident).toHaveBeenCalledWith(accountId);
    const calls = vi.mocked(queueAutomationRun).mock.calls.map(([input]) => input);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      automationId,
      trigger: {
        attributes: {
          cause: "Status 500",
          incidentId: "987654",
          incidentName: "Checkout API",
          integrationAccountId: accountId,
          monitorId: "4321",
          startedAt: "2026-10-22T10:51:28.151Z",
          url: "https://api.acme.example/health",
        },
        body: expect.any(String),
        externalEventId: `${accountId}:987654:2026-10-22T10:51:28.151Z`,
        provider: "betterstack",
        sourceUrl: "https://incidents.betterstack.com/team/0/incidents/987654",
        title: "Checkout API: Status 500",
      },
    });
    expect(JSON.parse(calls[0]!.trigger.body)).toMatchObject({
      data: { attributes: { response_content: "Internal Server Error" } },
    });
  });

  it("accepts the secret as a bearer token", async () => {
    const response = await deliver(incident(), { authorization: `Bearer ${betterStackWebhookSecret(accountId)}` });

    expect(response.status).toBe(200);
    expect(queueAutomationRun).toHaveBeenCalledTimes(1);
  });

  it("gives a retried delivery the same event ID", async () => {
    await deliver(incident());
    await deliver(incident());

    const ids = vi.mocked(queueAutomationRun).mock.calls.map(([input]) => input.trigger.externalEventId);
    expect(ids[1]).toBe(ids[0]);
  });

  it("reads the template's empty strings as unset", async () => {
    await deliver(incident({ acknowledged_at: "", resolved_at: "", started_at: "" }));

    const trigger = vi.mocked(queueAutomationRun).mock.calls[0]![0].trigger;
    expect(trigger.externalEventId).toBe(`${accountId}:987654:started`);
    expect(trigger.attributes?.startedAt).toBeNull();
  });

  it("ignores acknowledged and resolved incidents, comments, and other webhook types", async () => {
    const responses = await Promise.all([
      deliver(incident({ acknowledged_at: "2026-10-22T10:55:00.000Z" })),
      deliver(incident({ resolved_at: "2026-10-22T11:00:00.000Z" })),
      deliver(incident({}, { comment: { attributes: { content: "Looking" } }, event: "comment" })),
      deliver({ data: { attributes: { url: "https://acme.example" }, id: "4321", type: "monitor" } }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ignored: true, ok: true });
    }
    expect(findAutomationsForBetterStackIncident).not.toHaveBeenCalled();
  });

  it("names an incident without a cause after the incident", async () => {
    await deliver(incident({ cause: null }));

    expect(vi.mocked(queueAutomationRun).mock.calls[0]![0].trigger.title).toBe("Checkout API");
  });

  it("rejects a wrong password, a password for another connection, and no credentials", async () => {
    const wrong = await deliver(incident(), { authorization: basic("responder", "not-the-secret") });
    const otherConnection = await deliver(incident(), {
      authorization: basic("responder", betterStackWebhookSecret("90000000-0000-4000-8000-000000000000")),
    });
    const missing = await deliver(incident(), {});

    expect([wrong.status, otherConnection.status, missing.status]).toEqual([401, 401, 401]);
    expect(findAutomationsForBetterStackIncident).not.toHaveBeenCalled();
  });

  it("rejects incidents for a connection that is not connected", async () => {
    vi.mocked(getConnectedIntegrationAccountCredential).mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof getConnectedIntegrationAccountCredential>>,
    );

    const response = await deliver(incident());

    expect(response.status).toBe(401);
    expect(findAutomationsForBetterStackIncident).not.toHaveBeenCalled();
  });

  it("reports a body that is not a Better Stack incident", async () => {
    const notJson = await deliver("not json");
    const badId = await deliver({ data: { attributes: {}, id: "../../admin", type: "incident" } });

    expect(notJson.status).toBe(400);
    expect(badId.status).toBe(400);
    expect(findAutomationsForBetterStackIncident).not.toHaveBeenCalled();
  });

  it("asks Better Stack to retry when a run cannot be queued", async () => {
    vi.mocked(queueAutomationRun).mockRejectedValue(new Error("queue down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await deliver(incident());

    expect(response.status).toBe(502);
  });
});
