import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import { findAgentsForDash0Alert } from "../../../../packages/core/src/db/agents.js";
import { getConnectedIntegrationAccountCredential } from "../../../../packages/core/src/db/integrations.js";
import { queueInvestigation } from "../investigations/queue.js";
import { dash0WebhookRoutes } from "./dash0.js";

vi.mock("../../../../packages/core/src/credentials/encryption.js", () => ({
  decryptCredentials: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/agents.js", () => ({
  findAgentsForDash0Alert: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/integrations.js", () => ({
  getConnectedIntegrationAccountCredential: vi.fn(),
}));
vi.mock("../investigations/queue.js", () => ({ queueInvestigation: vi.fn() }));

const accountId = "10000000-0000-4000-8000-000000000000";
const app = new Hono().route("/api/webhooks/dash0", dash0WebhookRoutes);

function payload(type = "alert.ongoing") {
  return {
    type,
    data: {
      issue: {
        id: "issue-1",
        issueIdentifier: "stable-issue-1",
        dataset: "production",
        start: "2026-09-02T10:00:00Z",
        status: "critical",
        summary: "Checkout error rate is high",
        description: "More than 5% of requests are failing.",
        checkrules: [
          {
            id: "rule-1",
            version: 3,
            name: "Checkout error rate",
            url: "https://app.dash0.com/checks/rule-1",
          },
        ],
        url: "https://app.dash0.com/failed-checks/issue-1",
      },
    },
  };
}

describe("Dash0 webhooks", () => {
  afterEach(() => vi.clearAllMocks());

  function connected() {
    vi.mocked(getConnectedIntegrationAccountCredential).mockResolvedValue({
      encryptedCredentials: "encrypted",
      organizationId: "organization-1",
    });
    vi.mocked(decryptCredentials).mockReturnValue({
      authType: "oauth",
      mcpUrl: "https://mcp.eu-west-1.aws.dash0.com/mcp",
      oauth: {},
      webhookSecret: "dash0-webhook-secret-that-is-long-enough",
    });
  }

  it("authenticates and fans an ongoing alert out with retry-safe IDs", async () => {
    connected();
    vi.mocked(findAgentsForDash0Alert).mockResolvedValue([
      { agentId: "20000000-0000-4000-8000-000000000000", organizationId: "organization-1" },
      { agentId: "30000000-0000-4000-8000-000000000000", organizationId: "organization-1" },
    ]);
    vi.mocked(queueInvestigation).mockResolvedValue({
      kind: "queued",
      investigationId: "40000000-0000-4000-8000-000000000000",
      jobId: "50000000-0000-4000-8000-000000000000",
    });

    const response = await app.request(`/api/webhooks/dash0/${accountId}`, {
      method: "POST",
      headers: {
        authorization: "Bearer dash0-webhook-secret-that-is-long-enough",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload()),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, matchedAgents: 2 });
    expect(queueInvestigation).toHaveBeenCalledTimes(2);
    expect(queueInvestigation).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "dash0",
        externalEventId: `${accountId}:issue-1:20000000-0000-4000-8000-000000000000`,
        title: "Checkout error rate",
        sourceUrl: "https://app.dash0.com/failed-checks/issue-1",
        attributes: expect.objectContaining({ dataset: "production" }),
      }),
    );
  });

  it("rejects a request with the wrong bearer secret", async () => {
    connected();
    const response = await app.request(`/api/webhooks/dash0/${accountId}`, {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: JSON.stringify(payload()),
    });

    expect(response.status).toBe(401);
    expect(findAgentsForDash0Alert).not.toHaveBeenCalled();
  });

  it("acknowledges resolved alerts without starting investigations", async () => {
    connected();
    const response = await app.request(`/api/webhooks/dash0/${accountId}`, {
      method: "POST",
      headers: {
        authorization: "Bearer dash0-webhook-secret-that-is-long-enough",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload("alert.resolved")),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(queueInvestigation).not.toHaveBeenCalled();
  });
});
