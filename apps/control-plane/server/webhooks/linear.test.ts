import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findLinearAgentTarget,
  sendLinearAgentActivity,
} from "../../../../packages/core/src/db/linear-agent-sessions.js";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import { queueSlackThreadInvestigation } from "../investigations/queue.js";
import {
  linearAllowanceMessage,
  linearTagModeOffMessage,
  linearWebhookRoutes,
} from "./linear.js";

vi.mock("../../../../packages/core/src/db/linear-agent-sessions.js", () => ({
  findLinearAgentTarget: vi.fn(),
  sendLinearAgentActivity: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/organization-capabilities.js", () => ({
  organizationHasCapability: vi.fn(),
}));
vi.mock("../investigations/queue.js", () => ({
  queueSlackThreadInvestigation: vi.fn(),
}));

const secret = "linear-webhook-secret";
const agentId = "20000000-0000-4000-8000-000000000000";
const integrationAccountId = "30000000-0000-4000-8000-000000000000";
const investigationId = "40000000-0000-4000-8000-000000000000";
const app = new Hono().route("/api/webhooks/linear", linearWebhookRoutes);

function sessionEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "AgentSessionEvent",
    action: "created",
    organizationId: "linear-organization",
    webhookTimestamp: Date.now(),
    promptContext: "<issue identifier=\"ENG-1\">Checkout returns 503</issue>",
    agentSession: {
      id: "session-1",
      creator: { name: "Ada" },
      issue: {
        id: "issue-1",
        identifier: "ENG-1",
        title: "Checkout returns 503",
        url: "https://linear.app/acme/issue/ENG-1",
      },
    },
    ...overrides,
  };
}

function deliver(payload: unknown, signature?: string) {
  const body = JSON.stringify(payload);
  return app.request("/api/webhooks/linear", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-signature":
        signature ?? createHmac("sha256", secret).update(body).digest("hex"),
    },
    body,
  });
}

describe("Linear webhooks", () => {
  beforeEach(() => {
    vi.stubEnv("LINEAR_WEBHOOK_SECRET", secret);
    vi.mocked(findLinearAgentTarget).mockResolvedValue({
      integrationAccountId,
      organizationId: "organization-1",
      tagMode: { agentId, enabled: true },
    });
    vi.mocked(organizationHasCapability).mockResolvedValue(true);
    vi.mocked(sendLinearAgentActivity).mockResolvedValue(undefined);
    vi.mocked(queueSlackThreadInvestigation).mockResolvedValue({
      investigationId,
      jobId: "50000000-0000-4000-8000-000000000000",
      kind: "queued",
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("rejects an unsigned delivery", async () => {
    const response = await deliver(sessionEvent(), "0".repeat(64));

    expect(response.status).toBe(401);
    expect(queueSlackThreadInvestigation).not.toHaveBeenCalled();
  });

  it("queues a mention as a tag mode request in the agent session and acknowledges it", async () => {
    const response = await deliver(sessionEvent());

    expect(response.status).toBe(200);
    expect(queueSlackThreadInvestigation).toHaveBeenCalledWith(
      {
        agentId,
        provider: "linear",
        externalEventId: `session-1:${agentId}`,
        title: "ENG-1: Checkout returns 503",
        body: "<issue identifier=\"ENG-1\">Checkout returns 503</issue>",
        sourceUrl: "https://linear.app/acme/issue/ENG-1",
        attributes: {
          integrationAccountId,
          linearAgentSessionId: "session-1",
          linearIssueId: "issue-1",
          linearIssueIdentifier: "ENG-1",
          linearUserName: "Ada",
          slackAssistant: true,
        },
      },
      {
        teamId: "linear-organization",
        channelId: "issue-1",
        threadTimestamp: "session-1",
      },
    );
    await vi.waitFor(() =>
      expect(sendLinearAgentActivity).toHaveBeenCalledWith({
        agentSessionId: "session-1",
        content: { type: "thought", body: "Working on it." },
        ephemeral: true,
        integrationAccountId,
        organizationId: "organization-1",
      })
    );
  });

  it("queues a follow-up by its activity and runs investigations without simplified navigation", async () => {
    vi.mocked(organizationHasCapability).mockResolvedValue(false);

    await deliver(sessionEvent({
      action: "prompted",
      promptContext: undefined,
      agentActivity: {
        id: "activity-2",
        content: { type: "prompt", body: "Open a pull request for it." },
      },
    }));

    const [request] = vi.mocked(queueSlackThreadInvestigation).mock.calls[0]!;
    expect(request.externalEventId).toBe(`activity-2:${agentId}`);
    expect(request.body).toBe("Open a pull request for it.");
    expect(request.attributes).not.toHaveProperty("slackAssistant");
  });

  it("ignores a stop request", async () => {
    const response = await deliver(sessionEvent({
      action: "prompted",
      agentActivity: {
        id: "activity-3",
        content: { type: "prompt", body: "Stop" },
        signal: "stop",
      },
    }));

    expect(await response.json()).toEqual({ ok: true, ignored: true });
    expect(queueSlackThreadInvestigation).not.toHaveBeenCalled();
  });

  it("tells the session when tag mode is off", async () => {
    vi.mocked(findLinearAgentTarget).mockResolvedValue({
      integrationAccountId,
      organizationId: "organization-1",
      tagMode: { agentId, enabled: false },
    });

    await deliver(sessionEvent());

    expect(queueSlackThreadInvestigation).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(sendLinearAgentActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          content: { type: "error", body: linearTagModeOffMessage },
        }),
      )
    );
  });

  it("tells the session when the allowance is used up", async () => {
    vi.mocked(queueSlackThreadInvestigation).mockResolvedValue({ kind: "blocked" });

    const response = await deliver(sessionEvent());

    expect(response.status).toBe(200);
    await vi.waitFor(() =>
      expect(sendLinearAgentActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          content: { type: "error", body: linearAllowanceMessage },
        }),
      )
    );
  });
});
