import { describe, expect, it, vi } from "vitest";
import type { SlackHistoryMessage } from "@responder/core/integrations/slack-history";
import {
  formatSlackThreadContext,
  loadSlackThreadContext,
  maximumThreadContextMessages,
  unseenSlackThreadMessages,
  type SlackThreadContextDependencies,
} from "./slack-thread-context.js";

vi.mock("@responder/core/credentials/encryption", () => ({
  decryptCredentials: vi.fn(() => ({ accessToken: "xoxb-test" })),
}));

const alert: SlackHistoryMessage = {
  botId: "B1",
  text: "[responder-prod] AutomationHarnessError: Codex automation harness failed",
  timestamp: "1790949599.434699",
  username: "Sentry",
};
const triage: SlackHistoryMessage = {
  botId: "B2",
  text: "Sev-3: one automation run failed",
  threadTimestamp: alert.timestamp,
  timestamp: "1790949779.969089",
  username: "Superlog Responder",
};
const regression: SlackHistoryMessage = {
  botId: "B1",
  text: "AutomationHarnessError regressed",
  threadTimestamp: alert.timestamp,
  timestamp: "1791473881.426709",
  username: "Sentry",
};
const firstTag: SlackHistoryMessage = {
  text: "<@U0BME2RAKN2> wtf",
  threadTimestamp: alert.timestamp,
  timestamp: "1791474067.840019",
  userId: "U09L74606MQ",
};
const firstTrace: SlackHistoryMessage = {
  botId: "B2",
  text: "Trace",
  threadTimestamp: alert.timestamp,
  timestamp: "1791474070.178849",
  username: "Superlog Responder",
};
const firstAnswer: SlackHistoryMessage = {
  botId: "B2",
  text: "What happened?",
  threadTimestamp: alert.timestamp,
  timestamp: "1791474077.684279",
  username: "Superlog Responder",
};
const secondTag: SlackHistoryMessage = {
  text: "<@U0BME2RAKN2> above",
  threadTimestamp: alert.timestamp,
  timestamp: "1791474094.780269",
  userId: "U09L74606MQ",
};
const thread = [alert, triage, regression, firstTag, firstTrace, firstAnswer, secondTag];

describe("unseen Slack thread messages", () => {
  it("gives the first turn every message before the tag", () => {
    expect(unseenSlackThreadMessages({
      currentTimestamp: firstTag.timestamp,
      messages: thread,
      turns: [],
    })).toEqual([alert, triage, regression]);
  });

  it("gives a later turn only what arrived since the previous turn, minus its own posts", () => {
    expect(unseenSlackThreadMessages({
      currentTimestamp: secondTag.timestamp,
      messages: thread,
      turns: [{
        messageTimestamp: firstTag.timestamp,
        postedTimestamps: [firstTrace.timestamp, firstAnswer.timestamp],
      }],
    })).toEqual([]);
  });

  it("keeps another app's messages posted since the previous turn", () => {
    expect(unseenSlackThreadMessages({
      currentTimestamp: secondTag.timestamp,
      messages: [...thread.slice(0, 6), { ...regression, timestamp: "1791474080.000001" }, secondTag],
      turns: [{
        messageTimestamp: firstTag.timestamp,
        postedTimestamps: [firstTrace.timestamp, firstAnswer.timestamp],
      }],
    }).map((message) => message.timestamp)).toEqual(["1791474080.000001"]);
  });

  it("ignores a turn queued after the current message", () => {
    expect(unseenSlackThreadMessages({
      currentTimestamp: firstTag.timestamp,
      messages: thread,
      turns: [{ messageTimestamp: secondTag.timestamp, postedTimestamps: [] }],
    })).toEqual([alert, triage, regression]);
  });

  it("orders timestamps by their microseconds", () => {
    expect(unseenSlackThreadMessages({
      currentTimestamp: "1791474067.000010",
      messages: [
        { text: "before", timestamp: "1791474067.000009" },
        { text: "after", timestamp: "1791474067.000011" },
      ],
      turns: [],
    }).map((message) => message.text)).toEqual(["before"]);
  });
});

describe("Slack thread context", () => {
  it("lists the messages with their authors and times", () => {
    expect(formatSlackThreadContext({
      messages: [alert, triage, { ...firstTag, text: "what broke?" }],
      threadTimestamp: alert.timestamp,
    })).toBe([
      "# Earlier messages in this Slack thread",
      "",
      "Oldest first. The request below is the newest message in the thread.",
      "",
      "[2026-10-02T13:59:59Z] Sentry: [responder-prod] AutomationHarnessError: Codex automation harness failed",
      "[2026-10-02T14:02:59Z] Superlog Responder: Sev-3: one automation run failed",
      "[2026-10-08T15:41:07Z] <@U09L74606MQ>: what broke?",
    ].join("\n"));
  });

  it("has nothing to add without earlier messages", () => {
    expect(formatSlackThreadContext({ messages: [], threadTimestamp: alert.timestamp })).toBeNull();
  });

  it("keeps the thread's first message and the newest replies of a long thread", () => {
    const replies = Array.from({ length: maximumThreadContextMessages + 5 }, (_, index) => ({
      text: `reply ${index}`,
      timestamp: `1791474100.${String(index).padStart(6, "0")}`,
      userId: "U1",
    }));
    const context = formatSlackThreadContext({
      messages: [alert, ...replies],
      threadTimestamp: alert.timestamp,
    })!;

    expect(context).toContain("Sentry: [responder-prod]");
    expect(context).toContain("(6 more messages omitted)");
    expect(context).not.toContain("reply 5\n");
    expect(context).toContain("reply 6\n");
    expect(context.endsWith(`reply ${maximumThreadContextMessages + 4}`)).toBe(true);
  });
});

describe("loading Slack thread context", () => {
  function dependencies(
    overrides: Partial<SlackThreadContextDependencies> = {},
  ): SlackThreadContextDependencies {
    return {
      getLiveContext: vi.fn().mockResolvedValue({
        source: {
          channelId: "C0BQ2BZUVK6",
          encryptedCredentials: "encrypted",
          messageTimestamp: null,
          reactionTimestamp: firstTag.timestamp,
          threadTimestamp: alert.timestamp,
        },
      }),
      getTurns: vi.fn().mockResolvedValue([]),
      readThread: vi.fn().mockResolvedValue({ channelId: "C0BQ2BZUVK6", messages: thread }),
      ...overrides,
    } as SlackThreadContextDependencies;
  }

  it("reads the tag's thread with the workspace's bot token", async () => {
    const loaded = dependencies();

    const context = await loadSlackThreadContext(
      { investigationId: "investigation-1", sessionId: "session-1" },
      loaded,
    );

    expect(loaded.readThread).toHaveBeenCalledWith({
      accessToken: "xoxb-test",
      channelId: "C0BQ2BZUVK6",
      cursor: undefined,
      limit: 200,
      threadTimestamp: alert.timestamp,
    });
    expect(loaded.getTurns).toHaveBeenCalledWith({
      investigationId: "investigation-1",
      sessionId: "session-1",
    });
    expect(context).toContain("AutomationHarnessError regressed");
    expect(context).not.toContain("wtf");
  });

  it("follows the thread's pages", async () => {
    const readThread = vi.fn()
      .mockResolvedValueOnce({ channelId: "C1", messages: [alert], nextCursor: "next" })
      .mockResolvedValueOnce({ channelId: "C1", messages: [triage] });

    const context = await loadSlackThreadContext(
      { investigationId: "investigation-1", sessionId: "session-1" },
      dependencies({ readThread }),
    );

    expect(readThread).toHaveBeenCalledTimes(2);
    expect(readThread.mock.calls[1]![0]).toMatchObject({ cursor: "next" });
    expect(context).toContain("Sev-3");
  });

  it("skips a tag that starts its own thread", async () => {
    const loaded = dependencies({
      getLiveContext: vi.fn().mockResolvedValue({
        source: {
          channelId: "C1",
          encryptedCredentials: "encrypted",
          messageTimestamp: null,
          reactionTimestamp: alert.timestamp,
          threadTimestamp: alert.timestamp,
        },
      }),
    });

    await expect(loadSlackThreadContext(
      { investigationId: "investigation-1", sessionId: "session-1" },
      loaded,
    )).resolves.toBeNull();
    expect(loaded.readThread).not.toHaveBeenCalled();
  });

  it("answers from the message alone when Slack refuses the read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(loadSlackThreadContext(
      { investigationId: "investigation-1", sessionId: "session-1" },
      dependencies({ readThread: vi.fn().mockRejectedValue(new Error("not_in_channel")) }),
    )).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("slack_thread_context_failed"));
    error.mockRestore();
  });
});
