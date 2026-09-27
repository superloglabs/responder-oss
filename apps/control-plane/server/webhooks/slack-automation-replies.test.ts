import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slackWebhookRoutes } from "./slack.js";

const mocks = vi.hoisted(() => ({
  findAgents: vi.fn(),
  findAutomations: vi.fn(),
  findThreadRun: vi.fn(),
  queueReply: vi.fn(),
  queueRun: vi.fn(),
}));

vi.mock("../../../../packages/core/src/db/automations.js", () => ({
  findAutomationsForSlackEvent: mocks.findAutomations,
  findSlackThreadAutomationRun: mocks.findThreadRun,
}));
vi.mock("../automations/queue.js", () => ({
  queueAutomationRun: mocks.queueRun,
  queueAutomationRunReply: mocks.queueReply,
}));
vi.mock("../../../../packages/core/src/db/agents.js", () => ({
  findAgentsForSlackEvent: mocks.findAgents,
}));

const signingSecret = "slack-signing-secret";
const automationId = "31313131-3131-4131-8131-313131313131";
const runId = "21212121-2121-4121-8121-212121212121";

function deliver(event: Record<string, unknown>) {
  const body = JSON.stringify({
    event: { channel: "C123", text: "Can you open a PR?", ts: "1790000002.000100", type: "message", ...event },
    event_id: "Ev1",
    team_id: "T123",
    type: "event_callback",
  });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return slackWebhookRoutes.request("/", {
    body,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    method: "POST",
  });
}

describe("Slack replies to automation runs", () => {
  beforeEach(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", signingSecret);
    mocks.findAgents.mockResolvedValue([]);
    mocks.findAutomations.mockResolvedValue([{ automationId }]);
    mocks.findThreadRun.mockResolvedValue({ id: runId, organizationId: "org" });
    mocks.queueReply.mockResolvedValue("queued");
    mocks.queueRun.mockResolvedValue({ duplicate: false, runId });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("sends a person's reply in the run's thread to that run", async () => {
    const response = await deliver({
      thread_ts: "1790000000.000100",
      user: "U123",
      user_profile: { display_name: "Ada", real_name: "Ada Lovelace" },
    });

    expect(response.status).toBe(200);
    expect(mocks.findThreadRun).toHaveBeenCalledWith({
      automationId,
      channelId: "C123",
      teamId: "T123",
      threadTimestamp: "1790000000.000100",
    });
    expect(mocks.queueReply).toHaveBeenCalledWith({
      message: {
        authorId: "U123",
        authorName: "Ada",
        externalEventId: "C123:1790000002.000100",
        source: "slack",
        text: "Can you open a PR?",
      },
      runId,
    });
    expect(mocks.queueRun).not.toHaveBeenCalled();
  });

  it("starts a new run for a reply in a thread without one", async () => {
    mocks.findThreadRun.mockResolvedValue(null);

    await deliver({ thread_ts: "1790000000.000100", user: "U123" });

    expect(mocks.queueReply).not.toHaveBeenCalled();
    expect(mocks.queueRun).toHaveBeenCalledWith(expect.objectContaining({
      automationId,
      trigger: expect.objectContaining({
        attributes: expect.objectContaining({ threadTimestamp: "1790000000.000100" }),
      }),
    }));
  });

  it("starts a new run for an alert posted in the thread by another app", async () => {
    await deliver({
      bot_id: "B123",
      bot_profile: { app_id: "A123", name: "Deploy Bot" },
      thread_ts: "1790000000.000100",
    });

    expect(mocks.findThreadRun).not.toHaveBeenCalled();
    expect(mocks.queueRun).toHaveBeenCalledOnce();
  });

  it("starts a new run for a message outside a thread", async () => {
    await deliver({ user: "U123" });

    expect(mocks.findThreadRun).not.toHaveBeenCalled();
    expect(mocks.queueRun).toHaveBeenCalledOnce();
  });
});
