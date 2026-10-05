import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  slackAllowanceExhaustedReply,
  slackTagModeOffReply,
  slackWebhookRoutes,
  slackWelcomeMessage,
} from "./slack.js";

const mocks = vi.hoisted(() => ({
  accountCredential: vi.fn(),
  addReaction: vi.fn(),
  channelConnection: vi.fn(),
  claimWelcome: vi.fn(),
  findAgents: vi.fn(),
  findAutomations: vi.fn(),
  hasCapability: vi.fn(),
  listAccounts: vi.fn(),
  markWelcomeSent: vi.fn(),
  postMessage: vi.fn(),
  queueInvestigation: vi.fn(),
  queueRun: vi.fn(),
  queueThreadInvestigation: vi.fn(),
  recordMessage: vi.fn(),
  recordSource: vi.fn(),
  releaseWelcome: vi.fn(),
  setReaction: vi.fn(),
}));

vi.mock("../../../../packages/core/src/credentials/encryption.js", () => ({
  decryptCredentials: (value: string) => ({ accessToken: `token-for-${value}` }),
}));
vi.mock("../../../../packages/core/src/db/agents.js", () => ({
  findAgentsForSlackEvent: mocks.findAgents,
}));
vi.mock("../../../../packages/core/src/db/automations.js", () => ({
  findAutomationsForSlackEvent: mocks.findAutomations,
  findSlackThreadAutomationRun: vi.fn(),
  recordSlackMessageAuthor: vi.fn(),
}));
vi.mock("../automations/queue.js", () => ({
  queueAutomationRun: mocks.queueRun,
  queueAutomationRunReply: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/integrations.js", () => ({
  claimSlackDirectMessageWelcome: mocks.claimWelcome,
  getConnectedIntegrationAccountCredential: mocks.accountCredential,
  getSlackChannelConnection: mocks.channelConnection,
  listConnectedSlackAccountsForTeam: mocks.listAccounts,
  markSlackDirectMessageWelcomeSent: mocks.markWelcomeSent,
  releaseSlackDirectMessageWelcome: mocks.releaseWelcome,
}));
vi.mock("../../../../packages/core/src/db/investigations.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../packages/core/src/db/investigations.js")>(),
  findSlackIssueThread: vi.fn().mockResolvedValue(null),
  recordInvestigationSlackMessage: mocks.recordMessage,
  recordInvestigationSlackSource: mocks.recordSource,
  setInvestigationSlackReaction: mocks.setReaction,
}));
vi.mock("../../../../packages/core/src/db/organization-capabilities.js", () => ({
  organizationHasCapability: mocks.hasCapability,
}));
vi.mock("../../../../packages/core/src/integrations/slack.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../packages/core/src/integrations/slack.js")>(),
  addSlackReaction: mocks.addReaction,
  postSlackMessage: mocks.postMessage,
}));
vi.mock("../investigations/queue.js", () => ({
  queueInvestigation: mocks.queueInvestigation,
  queueSlackThreadInvestigation: mocks.queueThreadInvestigation,
}));

const signingSecret = "slack-signing-secret";
const integrationAccountId = "41414141-4141-4141-8141-414141414141";
const investigationId = "51515151-5151-4151-8151-515151515151";
const tagMode = {
  agentId: "61616161-6161-4161-8161-616161616161",
  integrationAccountId,
  organizationId: "org",
  trigger: "slack_thread",
};
const account = {
  encryptedCredentials: "sealed",
  id: integrationAccountId,
  metadata: { botUserId: "UBOT" },
  organizationId: "org",
};

function sign(body: string) {
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

function directMessage(event: Record<string, unknown> = {}) {
  return sign(JSON.stringify({
    event: {
      channel: "D123",
      channel_type: "im",
      text: "Why is checkout slow?",
      ts: "1790000002.000100",
      type: "message",
      user: "U123",
      ...event,
    },
    event_id: "Ev1",
    team_id: "T123",
    type: "event_callback",
  }));
}

function openTab(tab: string) {
  return sign(JSON.stringify({
    event: { channel: "D123", tab, type: "app_home_opened", user: "U123" },
    event_id: "Ev2",
    team_id: "T123",
    type: "event_callback",
  }));
}

describe("Slack direct messages", () => {
  beforeEach(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", signingSecret);
    mocks.accountCredential.mockResolvedValue({ encryptedCredentials: "sealed", organizationId: "org" });
    mocks.addReaction.mockResolvedValue(undefined);
    mocks.channelConnection.mockResolvedValue(null);
    mocks.claimWelcome.mockResolvedValue(true);
    mocks.findAgents.mockResolvedValue([tagMode]);
    mocks.findAutomations.mockResolvedValue([]);
    mocks.hasCapability.mockResolvedValue(true);
    mocks.listAccounts.mockResolvedValue([account]);
    mocks.postMessage.mockResolvedValue("1790000003.000100");
    mocks.queueThreadInvestigation.mockResolvedValue({ investigationId, kind: "queued" });
    mocks.recordMessage.mockResolvedValue("investigating");
    mocks.recordSource.mockResolvedValue(undefined);
    mocks.releaseWelcome.mockResolvedValue(undefined);
    mocks.setReaction.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("answers a direct message with tag mode in the message's thread", async () => {
    const response = await directMessage();

    expect(await response.json()).toEqual({ matchedAgents: 1, ok: true });
    expect(mocks.findAgents).toHaveBeenCalledWith({
      channelId: "D123",
      eventType: "direct_message",
      teamId: "T123",
      userId: "U123",
    });
    expect(mocks.queueThreadInvestigation).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: tagMode.agentId,
        attributes: expect.objectContaining({
          channelId: "D123",
          integrationAccountId,
          slackAssistant: true,
          slackUserId: "U123",
          threadTimestamp: "1790000002.000100",
        }),
        body: "Why is checkout slow?",
      }),
      { channelId: "D123", teamId: "T123", threadTimestamp: "1790000002.000100" },
    );
    expect(mocks.queueRun).not.toHaveBeenCalled();
    // The acknowledgement uses the account's token; a direct message is not a
    // synced channel.
    expect(mocks.channelConnection).not.toHaveBeenCalled();
    expect(mocks.accountCredential).toHaveBeenCalledWith({ integrationAccountId, provider: "slack" });
    expect(mocks.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: "token-for-sealed",
      channelId: "D123",
      threadTimestamp: "1790000002.000100",
    }));
  });

  it("continues the conversation from a reply in its thread", async () => {
    await directMessage({ thread_ts: "1790000000.000100" });

    expect(mocks.queueThreadInvestigation).toHaveBeenCalledWith(
      expect.anything(),
      { channelId: "D123", teamId: "T123", threadTimestamp: "1790000000.000100" },
    );
  });

  it("names the files in a direct message", async () => {
    await directMessage({
      files: [{ id: "F123", name: "trace.png" }, { id: "F456", title: "Heap dump" }],
      subtype: "file_share",
      text: "",
    });

    expect(mocks.queueThreadInvestigation).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "The person attached files you can't open: trace.png, Heap dump",
      }),
      expect.anything(),
    );
  });

  it("keeps block text when a direct message with a file has no plain text", async () => {
    await directMessage({
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "See the trace" } }],
      files: [{ id: "F123", name: "trace.png" }],
      subtype: "file_share",
      text: "",
    });

    expect(mocks.queueThreadInvestigation).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "See the trace\n\nThe person attached files you can't open: trace.png",
      }),
      expect.anything(),
    );
  });

  it("ignores the app's own messages", async () => {
    const response = await directMessage({ bot_id: "B123", subtype: "bot_message" });

    expect(await response.json()).toEqual({ ignored: true, ok: true, reason: "direct_message_from_app" });
    expect(mocks.findAgents).not.toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it("ignores a mention in a direct message, which also arrives as a message", async () => {
    const response = await sign(JSON.stringify({
      event: { channel: "D123", text: "<@UBOT> hi", ts: "1790000002.000100", type: "app_mention", user: "U123" },
      event_id: "Ev3",
      team_id: "T123",
      type: "event_callback",
    }));

    expect(await response.json()).toEqual({ ignored: true, ok: true });
    expect(mocks.queueThreadInvestigation).not.toHaveBeenCalled();
  });

  it("explains that tag mode is off", async () => {
    mocks.findAgents.mockResolvedValue([]);

    await directMessage();

    expect(mocks.queueThreadInvestigation).not.toHaveBeenCalled();
    expect(mocks.postMessage).toHaveBeenCalledWith({
      accessToken: "token-for-sealed",
      channelId: "D123",
      text: slackTagModeOffReply,
      threadTimestamp: "1790000002.000100",
    });
  });

  it("explains that the workspace has no allowance left", async () => {
    mocks.queueThreadInvestigation.mockResolvedValue({ kind: "blocked" });

    await directMessage();

    expect(mocks.postMessage).toHaveBeenCalledTimes(1);
    expect(mocks.postMessage).toHaveBeenCalledWith({
      accessToken: "token-for-sealed",
      channelId: "D123",
      text: slackAllowanceExhaustedReply,
      threadTimestamp: "1790000002.000100",
    });
  });

  it("does not report the usage limit when another organization answers", async () => {
    mocks.findAgents.mockResolvedValue([
      tagMode,
      { ...tagMode, agentId: "71717171-7171-4171-8171-717171717171", organizationId: "other-org" },
    ]);
    mocks.queueThreadInvestigation
      .mockResolvedValueOnce({ kind: "blocked" })
      .mockResolvedValueOnce({ investigationId, kind: "queued" });
    mocks.accountCredential.mockResolvedValue({ encryptedCredentials: "sealed", organizationId: "other-org" });

    await directMessage();

    expect(mocks.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: slackAllowanceExhaustedReply }),
    );
  });
});

describe("Slack messages tab welcome", () => {
  beforeEach(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", signingSecret);
    mocks.claimWelcome.mockResolvedValue(true);
    mocks.listAccounts.mockResolvedValue([account]);
    mocks.postMessage.mockResolvedValue("1790000003.000100");
    mocks.releaseWelcome.mockResolvedValue(undefined);
    mocks.markWelcomeSent.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("welcomes a person the first time they open the messages tab", async () => {
    const response = await openTab("messages");

    expect(await response.json()).toEqual({ ok: true, welcomed: true });
    expect(mocks.claimWelcome).toHaveBeenCalledWith({ teamId: "T123", userId: "U123" });
    expect(mocks.postMessage).toHaveBeenCalledWith({
      accessToken: "token-for-sealed",
      channelId: "D123",
      text: slackWelcomeMessage("UBOT"),
    });
    expect(slackWelcomeMessage("UBOT")).toContain("<@UBOT>");
    expect(mocks.markWelcomeSent).toHaveBeenCalledWith({ teamId: "T123", userId: "U123" });
  });

  it("does not welcome a person twice", async () => {
    mocks.claimWelcome.mockResolvedValue(false);

    const response = await openTab("messages");

    expect(await response.json()).toEqual({ ok: true, welcomed: false });
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it("does not welcome from the home tab", async () => {
    await openTab("home");

    expect(mocks.claimWelcome).not.toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it("tries again next time when the welcome fails to post", async () => {
    mocks.postMessage.mockRejectedValue(new Error("channel_not_found"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await openTab("messages");

    expect(await response.json()).toEqual({ ok: true, welcomed: false });
    expect(mocks.releaseWelcome).toHaveBeenCalledWith({ teamId: "T123", userId: "U123" });
  });
});
