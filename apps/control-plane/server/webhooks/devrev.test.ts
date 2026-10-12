import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import { findAutomationsForDevRevTicket } from "../../../../packages/core/src/db/automations.js";
import { getConnectedIntegrationAccountCredential } from "../../../../packages/core/src/db/integrations.js";
import { queueAutomationRun } from "../automations/queue.js";
import { devrevWebhookRoutes } from "./devrev.js";

vi.mock("../../../../packages/core/src/credentials/encryption.js", () => ({
  decryptCredentials: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/automations.js", () => ({
  findAutomationsForDevRevTicket: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/integrations.js", () => ({
  getConnectedIntegrationAccountCredential: vi.fn(),
}));
vi.mock("../automations/queue.js", () => ({ queueAutomationRun: vi.fn() }));

const accountId = "10000000-0000-4000-8000-000000000000";
const secret = "webhook-secret";
const app = new Hono().route("/api/webhooks/devrev", devrevWebhookRoutes);

function workCreated(type = "ticket") {
  return {
    id: "don:integration:dvrv-us-1:devo/1abc:webhook/1:event/2",
    timestamp: "2026-10-12T12:00:00Z",
    type: "work_created",
    webhook_id: "don:integration:dvrv-us-1:devo/1abc:webhook/1",
    work_created: {
      work: {
        body: "Checkout fails with a 500 since this morning.",
        display_id: "TKT-42",
        id: "don:core:dvrv-us-1:devo/1abc:ticket/42",
        severity: "high",
        title: "Checkout is down",
        type,
      },
    },
  };
}

function deliver(body: unknown, signature?: string) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return app.request(`/api/webhooks/devrev/${accountId}`, {
    body: raw,
    headers: {
      "content-type": "application/json",
      "x-devrev-signature": signature ?? createHmac("sha256", secret).update(raw).digest("hex"),
    },
    method: "POST",
  });
}

describe("DevRev webhooks", () => {
  beforeEach(() => {
    vi.mocked(getConnectedIntegrationAccountCredential).mockResolvedValue({
      encryptedCredentials: "encrypted",
      metadata: { organizationSlug: "acme" },
      organizationId: "organization-1",
    });
    vi.mocked(decryptCredentials).mockReturnValue({
      authType: "personal_access_token",
      token: "token",
      webhookId: "webhook-1",
      webhookSecret: secret,
    });
    vi.mocked(queueAutomationRun).mockResolvedValue({ duplicate: false, runId: "run" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("answers the verification challenge in either format", async () => {
    const current = await deliver({ type: "verify", verify: { challenge: "abc" } }, "unsigned");
    const legacy = await deliver({ challenge: "def", type: "webhook_verify" }, "unsigned");

    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({ challenge: "abc" });
    expect(await legacy.json()).toEqual({ challenge: "def" });
    expect(getConnectedIntegrationAccountCredential).not.toHaveBeenCalled();
  });

  it("starts each automation watching the connection once per ticket", async () => {
    vi.mocked(findAutomationsForDevRevTicket).mockResolvedValue([
      { automationId: "20000000-0000-4000-8000-000000000000" },
      { automationId: "30000000-0000-4000-8000-000000000000" },
    ]);

    const response = await deliver(workCreated());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ matchedAutomations: 2, ok: true });
    expect(findAutomationsForDevRevTicket).toHaveBeenCalledWith(accountId);
    const calls = vi.mocked(queueAutomationRun).mock.calls.map(([input]) => input);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      automationId: "20000000-0000-4000-8000-000000000000",
      trigger: {
        attributes: {
          displayId: "TKT-42",
          integrationAccountId: accountId,
          severity: "high",
          ticketId: "don:core:dvrv-us-1:devo/1abc:ticket/42",
        },
        body: expect.stringContaining("Checkout fails with a 500"),
        externalEventId: `${accountId}:don:core:dvrv-us-1:devo/1abc:ticket/42`,
        provider: "devrev",
        sourceUrl: "https://app.devrev.ai/acme/works/TKT-42",
        title: "TKT-42: Checkout is down",
      },
    });
  });

  it("ignores work items that are not tickets", async () => {
    const response = await deliver(workCreated("issue"));

    expect(await response.json()).toEqual({ ignored: true, ok: true });
    expect(findAutomationsForDevRevTicket).not.toHaveBeenCalled();
  });

  it("rejects a bad signature or an unknown connection", async () => {
    expect((await deliver(workCreated(), "0".repeat(64))).status).toBe(401);
    vi.mocked(getConnectedIntegrationAccountCredential).mockResolvedValueOnce(
      null as unknown as Awaited<ReturnType<typeof getConnectedIntegrationAccountCredential>>,
    );
    expect((await deliver(workCreated())).status).toBe(401);
    expect((await app.request("/api/webhooks/devrev/not-an-id", { body: "{}", method: "POST" })).status).toBe(401);
    expect(queueAutomationRun).not.toHaveBeenCalled();
  });

  it("asks DevRev to retry when a run cannot be queued", async () => {
    vi.mocked(findAutomationsForDevRevTicket).mockResolvedValue([
      { automationId: "20000000-0000-4000-8000-000000000000" },
    ]);
    vi.mocked(queueAutomationRun).mockRejectedValueOnce(new Error("queue down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect((await deliver(workCreated())).status).toBe(502);
  });
});
