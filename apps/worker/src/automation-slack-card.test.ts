import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptCredentials } from "@responder/core/credentials/encryption";
import {
  automationSlackCardTarget,
  automationSlackCardUpdateIntervalMs,
  createAutomationSlackCard,
  type AutomationSlackCardDependencies,
} from "./automation-slack-card.js";

vi.mock("@responder/core/credentials/encryption", () => ({
  decryptCredentials: vi.fn(),
}));

const slackTrigger = {
  attributes: {
    channelId: "C123",
    teamId: "T123",
    threadTimestamp: "1790000000.000100",
    timestamp: "1790000000.000200",
  },
  body: "The deployment failed",
  externalEventId: "event-1",
  provider: "slack",
  title: "Deployment failed",
};

const slackConnection = {
  encryptedCredentials: "encrypted-slack-token",
  externalAccountId: "T123",
  provider: "slack",
};

const target = {
  accessToken: "xoxb-token",
  channelId: "C123",
  mentioned: false,
  threadTimestamp: "1790000000.000100",
};

const tool = (target: string) => ({
  action: "query" as const,
  kind: "tool" as const,
  provider: "sentry",
  status: "succeeded" as const,
  target,
});

describe("automation Slack card target", () => {
  beforeEach(() => {
    vi.mocked(decryptCredentials).mockReturnValue({ accessToken: "xoxb-token" });
  });

  it("posts in the triggering thread through the workspace's connection", () => {
    expect(automationSlackCardTarget(slackTrigger, [
      { ...slackConnection, externalAccountId: "T999" },
      slackConnection,
    ])).toEqual(target);
    expect(decryptCredentials).toHaveBeenCalledWith("encrypted-slack-token");
  });

  it("threads a top-level message under itself", () => {
    const attributes: Partial<typeof slackTrigger.attributes> = { ...slackTrigger.attributes };
    delete attributes.threadTimestamp;
    expect(automationSlackCardTarget(
      { ...slackTrigger, attributes },
      [slackConnection],
    )?.threadTimestamp).toBe("1790000000.000200");
  });

  it("skips runs that Slack did not start or cannot reach", () => {
    expect(automationSlackCardTarget({ ...slackTrigger, provider: "sentry" }, [slackConnection])).toBeNull();
    expect(automationSlackCardTarget(slackTrigger, [{ ...slackConnection, externalAccountId: "T999" }])).toBeNull();
    expect(automationSlackCardTarget(slackTrigger, [{ ...slackConnection, encryptedCredentials: null }])).toBeNull();
  });
});

describe("automation Slack card", () => {
  let now = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    now = Date.parse("2026-09-22T19:00:00.000Z");
  });
  afterEach(() => vi.useRealTimers());

  function card(overrides: {
    agentPosted?: () => Promise<boolean>;
    post?: AutomationSlackCardDependencies["post"];
    update?: AutomationSlackCardDependencies["update"];
  } = {}) {
    const dependencies = {
      now: () => now,
      post: vi.fn(overrides.post ?? (async () => "1790000001.000300")),
      update: vi.fn(overrides.update ?? (async () => undefined)),
    };
    const onError = vi.fn();
    return {
      card: createAutomationSlackCard({
        ...(overrides.agentPosted ? { agentPosted: overrides.agentPosted } : {}),
        automationId: "31313131-3131-4131-8131-313131313131",
        dependencies,
        onError,
        organizationId: "15151515-1515-4515-8515-151515151515",
        runId: "21212121-2121-4121-8121-212121212121",
        target,
      }),
      dependencies,
      onError,
    };
  }

  const taskTitles = (call: unknown) => (
    (call as { blocks: Array<{ tasks: Array<{ title: string }> }> }).blocks[0]!.tasks
  ).map((task) => task.title);

  it("posts a running card in the thread, throttles updates, and finishes it", async () => {
    const { card: slackCard, dependencies } = card();

    await slackCard.start();
    expect(dependencies.post).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "C123",
      text: "Automation running",
      threadTimestamp: "1790000000.000100",
    }));

    // Inside the interval, the update waits and then sends the latest items.
    slackCard.progress([tool("search_events")]);
    slackCard.progress([tool("search_events"), tool("get_sentry_resource")]);
    expect(dependencies.update).not.toHaveBeenCalled();
    now += automationSlackCardUpdateIntervalMs;
    await vi.advanceTimersByTimeAsync(automationSlackCardUpdateIntervalMs);
    expect(dependencies.update).toHaveBeenCalledOnce();
    expect(taskTitles(dependencies.update.mock.calls[0]![0])).toEqual([
      "Search Sentry events",
      "Get Sentry resource",
      "Automation running",
    ]);

    await slackCard.finish("complete");
    expect(dependencies.update).toHaveBeenLastCalledWith(expect.objectContaining({
      text: "Automation complete",
      timestamp: "1790000001.000300",
    }));

    // A finished card ignores later progress.
    slackCard.progress([tool("search_events"), tool("get_sentry_resource"), tool("whoami")]);
    await vi.runAllTimersAsync();
    expect(dependencies.update).toHaveBeenCalledTimes(2);
  });

  it("sends the final state without waiting for a pending update", async () => {
    const { card: slackCard, dependencies } = card();
    await slackCard.start();
    slackCard.progress([tool("search_events")]);

    await slackCard.finish("error", "Automation run was cancelled");
    await vi.runAllTimersAsync();

    expect(dependencies.update).toHaveBeenCalledOnce();
    expect(dependencies.update).toHaveBeenCalledWith(expect.objectContaining({
      text: "Automation stopped: Automation run was cancelled",
    }));
  });

  it("reports Slack failures without throwing and skips updates after a failed post", async () => {
    const postError = new Error("channel_not_found");
    const { card: slackCard, dependencies, onError } = card({
      post: async () => { throw postError; },
    });

    await expect(slackCard.start()).resolves.toBeUndefined();
    slackCard.progress([tool("search_events")]);
    await expect(slackCard.finish("complete")).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(postError);
    expect(dependencies.update).not.toHaveBeenCalled();
  });

  it("waits for the agent to post in the thread before posting", async () => {
    let agentPosted = false;
    const check = vi.fn(async () => agentPosted);
    const { card: slackCard, dependencies } = card({ agentPosted: check });

    await slackCard.start();
    slackCard.progress([tool("search_events")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledOnce();
    expect(dependencies.post).not.toHaveBeenCalled();

    // Checks are throttled like updates; the next one finds the post.
    agentPosted = true;
    slackCard.progress([tool("search_events"), tool("get_sentry_resource")]);
    now += automationSlackCardUpdateIntervalMs;
    await vi.advanceTimersByTimeAsync(automationSlackCardUpdateIntervalMs);
    expect(dependencies.post).toHaveBeenCalledOnce();
    expect(taskTitles(dependencies.post.mock.calls[0]![0])).toEqual([
      "Search Sentry events",
      "Get Sentry resource",
      "Automation running",
    ]);

    await slackCard.finish("complete");
    expect(dependencies.update).toHaveBeenLastCalledWith(expect.objectContaining({
      text: "Automation complete",
      timestamp: "1790000001.000300",
    }));
  });

  it("tries the card again after a failed first post", async () => {
    const postError = new Error("ratelimited");
    const post = vi.fn<AutomationSlackCardDependencies["post"]>()
      .mockRejectedValueOnce(postError)
      .mockResolvedValue("1790000001.000300");
    const { card: slackCard, dependencies, onError } = card({ agentPosted: async () => true, post });

    await slackCard.start();
    slackCard.progress([tool("search_events")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(postError);

    await slackCard.finish("complete");
    expect(dependencies.post).toHaveBeenCalledTimes(2);
    expect(dependencies.post).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Automation complete" }));
  });

  it("posts nothing when the agent never posts in the thread", async () => {
    const { card: slackCard, dependencies } = card({ agentPosted: async () => false });

    await slackCard.start();
    slackCard.progress([tool("search_events")]);
    await slackCard.finish("error", "Automation run was cancelled");
    await vi.runAllTimersAsync();

    expect(dependencies.post).not.toHaveBeenCalled();
    expect(dependencies.update).not.toHaveBeenCalled();
  });

  it("keeps the run going when an update fails", async () => {
    const updateError = new Error("ratelimited");
    const { card: slackCard, onError } = card({
      update: async () => { throw updateError; },
    });
    await slackCard.start();

    await expect(slackCard.finish("complete")).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(updateError);
  });
});
