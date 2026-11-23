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
  recordSlackMessageAuthor: vi.fn().mockResolvedValue(undefined),
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

  it("accepts another configured app's events and looks up only that app's connections", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "default-app-secret");
    vi.stubEnv("SLACK_ADDITIONAL_APPS", JSON.stringify([{ appId: "A0OTHER", signingSecret }]));

    const response = await sign(JSON.stringify({
      api_app_id: "A0OTHER",
      event: { channel: "D123", channel_type: "im", text: "Hi", ts: "1790000002.000100", type: "message", user: "U123" },
      event_id: "Ev3",
      team_id: "T123",
      type: "event_callback",
    }));

    expect(response.status).toBe(200);
    expect(mocks.findAgents).toHaveBeenCalledWith(expect.objectContaining({ appId: "A0OTHER", teamId: "T123" }));
  });

  it("rejects a request no configured app signed", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "default-app-secret");
    vi.stubEnv("SLACK_ADDITIONAL_APPS", JSON.stringify([{ appId: "A0OTHER", signingSecret: "other-secret" }]));

    expect((await directMessage()).status).toBe(401);
    expect(mocks.findAgents).not.toHaveBeenCalled();
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

  it("answers a direct message only from the workspace that connected the team first", async () => {
    const laterTagMode = { ...tagMode, agentId: "71717171-7171-4171-8171-717171717171", organizationId: "later-org" };
    mocks.findAgents.mockResolvedValue([laterTagMode, tagMode]);
    mocks.listAccounts.mockResolvedValue([account, { ...account, id: "later-account", organizationId: "later-org" }]);

    expect(await (await directMessage()).json()).toEqual({ matchedAgents: 1, ok: true });

    expect(mocks.queueThreadInvestigation).toHaveBeenCalledOnce();
    expect(mocks.queueThreadInvestigation).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: tagMode.agentId }),
      expect.anything(),
    );
  });

  it("does not hand a direct message to a later workspace when the first has tag mode off", async () => {
    const laterTagMode = { ...tagMode, agentId: "71717171-7171-4171-8171-717171717171", organizationId: "later-org" };
    mocks.findAgents.mockResolvedValue([laterTagMode]);
    mocks.listAccounts.mockResolvedValue([account, { ...account, id: "later-account", organizationId: "later-org" }]);

    await directMessage();

    expect(mocks.queueThreadInvestigation).not.toHaveBeenCalled();
    expect(mocks.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: "token-for-sealed",
      text: slackTagModeOffReply,
    }));
  });

  it("ignores a direct message from a person in another Slack team", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await directMessage({ user_team: "T999" });

    expect(await response.json()).toEqual({ ignored: true, ok: true, reason: "author_outside_team" });
    expect(mocks.findAgents).not.toHaveBeenCalled();
    expect(mocks.queueThreadInvestigation).not.toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("ignores a direct message from a guest", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await directMessage({
      user_profile: { display_name: "Grace", is_restricted: true, team: "T123" },
      user_team: "T123",
    });

    expect(await response.json()).toEqual({ ignored: true, ok: true, reason: "author_outside_team" });
    expect(mocks.queueThreadInvestigation).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("answers a direct message from a member of the team", async () => {
    await directMessage({
      user_profile: { display_name: "Ada", is_restricted: false, is_ultra_restricted: false, team: "T123" },
      user_team: "T123",
    });

    expect(mocks.queueThreadInvestigation).toHaveBeenCalledOnce();
  });
});

describe("Slack mentions when more than one workspace holds the team", () => {
  const laterTagMode = {
    ...tagMode,
    agentId: "71717171-7171-4171-8171-717171717171",
    integrationAccountId: "later-account",
    organizationId: "later-org",
  };

  function mention(event: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) {
    return sign(JSON.stringify({
      event: {
        channel: "C123",
        text: "<@UBOT> Why is checkout slow?",
        ts: "1790000002.000100",
        type: "app_mention",
        user: "U123",
        ...event,
      },
      event_id: "Ev4",
      team_id: "T123",
      type: "event_callback",
      ...envelope,
    }));
  }

  beforeEach(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", signingSecret);
    mocks.accountCredential.mockResolvedValue({ encryptedCredentials: "sealed", organizationId: "org" });
    mocks.addReaction.mockResolvedValue(undefined);
    mocks.channelConnection.mockResolvedValue(null);
    mocks.findAgents.mockResolvedValue([laterTagMode, tagMode]);
    mocks.findAutomations.mockResolvedValue([]);
    mocks.hasCapability.mockResolvedValue(false);
    mocks.listAccounts.mockResolvedValue([account, { ...account, id: "later-account", organizationId: "later-org" }]);
    mocks.postMessage.mockResolvedValue("1790000003.000100");
    mocks.queueRun.mockResolvedValue({ duplicate: false, runId: "run-1" });
    mocks.queueThreadInvestigation.mockResolvedValue({ investigationId, kind: "queued" });
    mocks.recordMessage.mockResolvedValue("investigating");
    mocks.recordSource.mockResolvedValue(undefined);
    mocks.setReaction.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("answers with the workspace that connected the team first when no workspace chose the channel", async () => {
    expect(await (await mention()).json()).toEqual({ matchedAgents: 1, ok: true });

    expect(mocks.queueThreadInvestigation).toHaveBeenCalledOnce();
    expect(mocks.queueThreadInvestigation).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: tagMode.agentId }),
      expect.anything(),
    );
  });

  it("answers with the workspace whose agent chose the channel", async () => {
    const mentionAgent = {
      ...laterTagMode,
      agentId: "81818181-8181-4181-8181-818181818181",
      channelSelected: true,
      trigger: "slack_mention",
    };
    mocks.findAgents.mockResolvedValue([tagMode, mentionAgent]);
    mocks.queueInvestigation.mockResolvedValue({ investigationId, kind: "queued" });

    expect(await (await mention()).json()).toEqual({ matchedAgents: 1, ok: true });

    expect(mocks.queueInvestigation).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: mentionAgent.agentId }),
    );
    expect(mocks.queueThreadInvestigation).not.toHaveBeenCalled();
  });

  it("leaves a channel to the workspace whose automation chose it", async () => {
    mocks.findAutomations.mockResolvedValue([{
      automationId: "91919191-9191-4191-8191-919191919191",
      integrationAccountId: "later-account",
      mentioned: true,
      organizationId: "later-org",
      startsRun: true,
    }]);

    expect(await (await mention()).json()).toEqual({ matchedAgents: 0, matchedAutomations: 1, ok: true });

    expect(mocks.queueRun).toHaveBeenCalledOnce();
    expect(mocks.queueThreadInvestigation).not.toHaveBeenCalled();
  });

  it("keeps every match when one workspace holds the team", async () => {
    mocks.listAccounts.mockResolvedValue([account]);
    mocks.findAgents.mockResolvedValue([tagMode]);

    expect(await (await mention()).json()).toEqual({ matchedAgents: 1, ok: true });
  });

  it("ignores a mention from a person in another Slack team in a shared channel", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await mention({ user_team: "T999" }, { is_ext_shared_channel: true });

    expect(await response.json()).toEqual({ matchedAgents: 0, ok: true });
    expect(mocks.findAgents).not.toHaveBeenCalled();
    expect(mocks.queueThreadInvestigation).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("answers a member of another workspace in the same Enterprise Grid org", async () => {
    mocks.listAccounts.mockResolvedValue([account]);
    mocks.findAgents.mockResolvedValue([tagMode]);

    const response = await mention(
      { user_team: "T456" },
      { enterprise_id: "E123", is_ext_shared_channel: false },
    );

    expect(await response.json()).toEqual({ matchedAgents: 1, ok: true });
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
