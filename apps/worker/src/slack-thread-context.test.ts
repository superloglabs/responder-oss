import { describe, expect, it, vi } from "vitest";
import type { SlackHistoryMessage } from "@responder/core/integrations/slack-history";
import {
  formatSlackThreadContext,
  loadSlackThreadContext,
  maximumThreadContextLength,
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
      postedTimestamps: [],
      readThrough: null,
    })).toEqual([alert, triage, regression]);
  });

  it("gives a later turn only what arrived since the thread was read, minus the session's posts", () => {
    expect(unseenSlackThreadMessages({
      currentTimestamp: secondTag.timestamp,
      messages: thread,
      postedTimestamps: [firstTrace.timestamp, firstAnswer.timestamp],
      readThrough: firstTag.timestamp,
    })).toEqual([]);
  });

  it("keeps another app's messages posted since the thread was read", () => {
    expect(unseenSlackThreadMessages({
      currentTimestamp: secondTag.timestamp,
      messages: [...thread.slice(0, 6), { ...regression, timestamp: "1791474080.000001" }, secondTag],
      postedTimestamps: [firstTrace.timestamp, firstAnswer.timestamp],
      readThrough: firstTag.timestamp,
    }).map((message) => message.timestamp)).toEqual(["1791474080.000001"]);
  });

  it("gives the whole thread again when no turn has read it", () => {
    expect(unseenSlackThreadMessages({
      currentTimestamp: secondTag.timestamp,
      messages: thread,
      postedTimestamps: [firstTrace.timestamp, firstAnswer.timestamp],
      readThrough: null,
    })).toEqual([alert, triage, regression, firstTag]);
  });

  it("orders timestamps by their microseconds", () => {
    expect(unseenSlackThreadMessages({
      currentTimestamp: "1791474067.000010",
      messages: [
        { text: "before", timestamp: "1791474067.000009" },
        { text: "after", timestamp: "1791474067.000011" },
      ],
      postedTimestamps: [],
      readThrough: null,
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

  it("keeps the newest replies within the character limit", () => {
    const replies = Array.from({ length: 10 }, (_, index) => ({
      text: `${index}`.repeat(4_000),
      timestamp: `1791474100.${String(index).padStart(6, "0")}`,
      userId: "U1",
    }));
    const context = formatSlackThreadContext({
      messages: [alert, ...replies],
      threadTimestamp: alert.timestamp,
    })!;
    const kept = replies.filter((reply) => context.includes(reply.text));

    expect(context.length).toBeLessThan(maximumThreadContextLength + 1_000);
    expect(context).toContain("Sentry: [responder-prod]");
    expect(kept).toEqual(replies.slice(-7));
    expect(context).toContain("(3 more messages omitted)");
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
      getSessionContext: vi.fn().mockResolvedValue({ postedTimestamps: [], readThrough: null }),
      readThread: vi.fn().mockResolvedValue({ channelId: "C0BQ2BZUVK6", messages: thread }),
      ...overrides,
    } as SlackThreadContextDependencies;
  }

  it("reads the tag's thread with the workspace's bot token, within a time limit", async () => {
    const loaded = dependencies();

    const result = await loadSlackThreadContext(
      { investigationId: "investigation-1", sessionId: "session-1" },
      loaded,
    );

    expect(loaded.readThread).toHaveBeenCalledWith({
      accessToken: "xoxb-test",
      channelId: "C0BQ2BZUVK6",
      cursor: undefined,
      limit: 200,
      signal: expect.any(AbortSignal),
      threadTimestamp: alert.timestamp,
    });
    expect(loaded.getSessionContext).toHaveBeenCalledWith({
      investigationId: "investigation-1",
      sessionId: "session-1",
    });
    expect(result?.readThrough).toBe(firstTag.timestamp);
    expect(result?.context).toContain("AutomationHarnessError regressed");
    expect(result?.context).not.toContain("wtf");
  });

  it("pages to the end of a long thread and keeps its first message and newest replies", async () => {
    const page = (start: number) => Array.from({ length: 200 }, (_, index) => ({
      text: `reply ${start + index}`,
      timestamp: `1791000000.${String(start + index).padStart(6, "0")}`,
      userId: "U1",
    }));
    const readThread = vi.fn()
      .mockResolvedValueOnce({ channelId: "C1", messages: [alert, ...page(0)], nextCursor: "2" })
      .mockResolvedValueOnce({ channelId: "C1", messages: page(200), nextCursor: "3" })
      .mockResolvedValueOnce({ channelId: "C1", messages: [...page(400), firstTag] });

    const result = await loadSlackThreadContext(
      { investigationId: "investigation-1", sessionId: "session-1" },
      dependencies({ readThread }),
    );

    expect(readThread).toHaveBeenCalledTimes(3);
    expect(readThread.mock.calls[2]![0]).toMatchObject({ cursor: "3" });
    expect(result?.context).toContain("Sentry: [responder-prod]");
    expect(result?.context).toContain(`(${600 - maximumThreadContextMessages + 1} more messages omitted)`);
    expect(result?.context).not.toContain("reply 550\n");
    expect(result?.context).toContain("reply 551\n");
    expect(result?.context?.endsWith("reply 599")).toBe(true);
  });

  it("marks a tag that starts its own thread as read without calling Slack", async () => {
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
    )).resolves.toEqual({ context: null, readThrough: alert.timestamp });
    expect(loaded.readThread).not.toHaveBeenCalled();
  });

  it("answers from the message alone and keeps the boundary when Slack refuses the read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(loadSlackThreadContext(
      { investigationId: "investigation-1", sessionId: "session-1" },
      dependencies({ readThread: vi.fn().mockRejectedValue(new Error("not_in_channel")) }),
    )).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("slack_thread_context_failed"));
    error.mockRestore();
  });
});
