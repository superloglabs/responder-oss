import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import { SlackApiError } from "../../../../packages/core/src/integrations/slack.js";
import type { AutomationContextBrokerClaim } from "../../../../packages/core/src/db/automation-model-broker.js";
import {
  callSlackTool,
  slackToolDefinitions,
  slackToolScope,
} from "./slack-tools.js";

const runId = "21212121-2121-4121-8121-212121212121";
const slackTrigger = {
  attributes: {
    channelId: "C999",
    teamId: "T123",
    threadTimestamp: "100.000001",
    timestamp: "100.000005",
  },
  body: "@Responder look at this",
  provider: "slack",
};

function claim(overrides: Partial<AutomationContextBrokerClaim> = {}): AutomationContextBrokerClaim {
  return {
    account: {
      encryptedCredentials: encryptCredentials({
        accessToken: "xoxb-bot",
        userAccessToken: "xoxp-user",
      }),
      externalAccountId: "T123",
      id: "61616161-6161-4161-8161-616161616161",
      metadata: {},
      provider: "slack",
    },
    organizationId: "15151515-1515-4515-8515-151515151515",
    resources: [{ displayName: "incidents", externalId: "C123", kind: "slack_channel" }],
    roles: ["context"],
    runId,
    trigger: {},
    ...overrides,
  };
}

function dependencies() {
  return {
    addReaction: vi.fn().mockResolvedValue(undefined),
    appendEvent: vi.fn().mockResolvedValue(1),
    beginAttempt: vi.fn().mockResolvedValue({ id: "attempt-1", status: "started" }),
    completeAttempt: vi.fn().mockResolvedValue(undefined),
    failAttempt: vi.fn().mockResolvedValue(undefined),
    postMessage: vi.fn().mockResolvedValue("100.000009"),
    readChannel: vi.fn().mockResolvedValue({ channelId: "C123", messages: [] }),
    readThread: vi.fn().mockResolvedValue({ channelId: "C999", messages: [] }),
    search: vi.fn(),
  };
}

function call(
  activeClaim: AutomationContextBrokerClaim,
  deps: ReturnType<typeof dependencies>,
  name: string,
  args: Record<string, unknown>,
) {
  return callSlackTool({
    args,
    claim: activeClaim,
    dependencies: deps,
    name,
    signal: new AbortController().signal,
  });
}

function toolNames(activeClaim: AutomationContextBrokerClaim): string[] {
  return slackToolDefinitions(slackToolScope(activeClaim)).map((tool) => tool.name);
}

describe("automation Slack tools", () => {
  beforeEach(() => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
  });
  afterEach(() => vi.unstubAllEnvs());

  it("lists every tool for a context connection and marks writes", () => {
    const tools = slackToolDefinitions(slackToolScope(claim()));

    expect(tools.map((tool) => [tool.name, tool.annotations.readOnlyHint])).toEqual([
      ["slack_search_channel", true],
      ["slack_read_channel", true],
      ["slack_read_thread", true],
      ["slack_post_message", false],
      ["slack_add_reaction", false],
    ]);
  });

  it("limits a trigger-only connection to the thread that started the run", async () => {
    const triggerOnly = claim({ roles: ["trigger"], trigger: slackTrigger });
    const deps = dependencies();

    expect(toolNames(triggerOnly)).toEqual([
      "slack_read_thread",
      "slack_post_message",
      "slack_add_reaction",
    ]);
    const post = slackToolDefinitions(slackToolScope(triggerOnly))
      .find((tool) => tool.name === "slack_post_message")!;
    expect(post.inputSchema.required).toContain("thread_ts");
    expect(post.description).toContain("thread_ts 100.000001");

    await expect(call(triggerOnly, deps, "slack_post_message", {
      channel_id: "C999",
      text: "Looking into it.",
      thread_ts: "100.000001",
    })).resolves.toEqual({
      content: [{
        text: JSON.stringify({ channelId: "C999", timestamp: "100.000009", threadTimestamp: "100.000001" }),
        type: "text",
      }],
    });
    expect(deps.postMessage).toHaveBeenCalledWith({
      accessToken: "xoxb-bot",
      channelId: "C999",
      clientMessageId: "attempt-1",
      text: "Looking into it.",
      threadTimestamp: "100.000001",
    });

    for (const [name, args] of [
      ["slack_post_message", { channel_id: "C999", text: "top level" }],
      ["slack_post_message", { channel_id: "C999", text: "other thread", thread_ts: "50.000001" }],
      ["slack_post_message", { channel_id: "C123", text: "context channel" }],
      ["slack_read_thread", { channel_id: "C999", thread_ts: "50.000001" }],
      ["slack_read_channel", { channel_id: "C999" }],
      ["slack_add_reaction", { channel_id: "C999", name: "eyes", timestamp: "100.000007" }],
    ] as const) {
      await expect(call(triggerOnly, deps, name, args)).resolves.toMatchObject({ isError: true });
    }
    expect(deps.postMessage).toHaveBeenCalledOnce();
    expect(deps.readThread).not.toHaveBeenCalled();
    expect(deps.readChannel).not.toHaveBeenCalled();
    expect(deps.addReaction).not.toHaveBeenCalled();

    await call(triggerOnly, deps, "slack_add_reaction", {
      channel_id: "C999",
      name: ":eyes:",
      timestamp: "100.000005",
    });
    expect(deps.addReaction).toHaveBeenCalledWith({
      accessToken: "xoxb-bot",
      channelId: "C999",
      name: "eyes",
      timestamp: "100.000005",
    });
  });

  it("ignores a Slack trigger from another workspace", () => {
    const other = claim({
      roles: ["trigger"],
      trigger: { ...slackTrigger, attributes: { ...slackTrigger.attributes, teamId: "T999" } },
    });

    expect(toolNames(other)).toEqual([]);
  });

  it("keeps posts inside the connection's channels", async () => {
    const deps = dependencies();

    await expect(call(claim(), deps, "slack_post_message", {
      channel_id: "C555",
      text: "Not selected",
    })).resolves.toMatchObject({ isError: true });
    expect(deps.postMessage).not.toHaveBeenCalled();
  });

  it("records a post as an action and returns the earlier result for a repeat", async () => {
    const deps = dependencies();

    await call(claim(), deps, "slack_post_message", { channel_id: "C123", text: "Fixed." });
    expect(deps.beginAttempt).toHaveBeenCalledWith(expect.objectContaining({
      kind: "send_slack_message",
      redactedInput: { channelId: "C123" },
      retryFailed: true,
      runId,
    }));
    expect(deps.completeAttempt).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      externalReference: "C123:100.000009",
    });
    expect(deps.appendEvent).toHaveBeenCalledWith({
      data: { externalReference: "C123:100.000009", kind: "send_slack_message" },
      runId,
      type: "action_succeeded",
    });

    deps.beginAttempt.mockResolvedValue({
      externalReference: "C123:100.000009",
      id: "attempt-1",
      status: "existing_succeeded",
    });
    const repeated = await call(claim(), deps, "slack_post_message", { channel_id: "C123", text: "Fixed." });
    expect(JSON.parse(repeated.content[0]!.text)).toMatchObject({
      note: "This message was already posted in this run.",
      timestamp: "100.000009",
    });
    expect(deps.postMessage).toHaveBeenCalledOnce();
    expect(deps.beginAttempt.mock.calls[0]![0].idempotencyKey)
      .toBe(deps.beginAttempt.mock.calls[1]![0].idempotencyKey);
  });

  it("returns Slack errors to the agent and marks the attempt failed", async () => {
    const deps = dependencies();
    deps.postMessage.mockRejectedValue(new SlackApiError("chat.postMessage", "not_in_channel"));

    await expect(call(claim(), deps, "slack_post_message", {
      channel_id: "C123",
      text: "Fixed.",
    })).resolves.toEqual({
      content: [{ text: "Slack chat.postMessage failed: not_in_channel", type: "text" }],
      isError: true,
    });
    expect(deps.failAttempt).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      failureMessage: "Slack chat.postMessage failed (not_in_channel)",
    });
  });

  it("reads channel history with the bot token", async () => {
    const deps = dependencies();

    await call(claim(), deps, "slack_read_channel", { channel_id: "C123", limit: 5 });
    expect(deps.readChannel).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: "xoxb-bot",
      channelId: "C123",
      limit: 5,
    }));
  });
});
