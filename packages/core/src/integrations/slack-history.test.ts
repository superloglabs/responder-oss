import { describe, expect, it, vi } from "vitest";
import { SlackApiError } from "./slack.js";
import { readSlackChannelHistory, readSlackThread } from "./slack-history.js";

describe("Slack history", () => {
  it("reads a channel page with the bot token and returns a cursor for more", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      has_more: true,
      messages: [
        { reply_count: 2, text: "deploy failed", thread_ts: "1.000001", ts: "1.000001", user: "U1" },
        { bot_id: "B1", subtype: "bot_message", text: "x".repeat(4_100), ts: "0.500000" },
      ],
      ok: true,
      response_metadata: { next_cursor: "cursor-2" },
    }));

    const page = await readSlackChannelHistory({
      accessToken: "xoxb-bot",
      channelId: "C123",
      fetchImpl: fetchMock,
      limit: 2,
      oldest: "0.000000",
    });

    expect(page).toMatchObject({
      channelId: "C123",
      messages: [
        { replyCount: 2, text: "deploy failed", threadTimestamp: "1.000001", timestamp: "1.000001", userId: "U1" },
        { botId: "B1", subtype: "bot_message", timestamp: "0.500000", truncated: true },
      ],
      nextCursor: "cursor-2",
    });
    expect(page.messages[1]!.text).toHaveLength(4_001);
    const [url, init] = fetchMock.mock.calls[0]! as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe("https://slack.com/api/conversations.history");
    expect(Object.fromEntries(url.searchParams)).toEqual({ channel: "C123", limit: "2", oldest: "0.000000" });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer xoxb-bot");
  });

  it("reads a thread by its first message timestamp", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      has_more: false,
      messages: [{ text: "root", thread_ts: "1.000001", ts: "1.000001", user: "U1" }],
      ok: true,
      response_metadata: { next_cursor: "" },
    }));

    const page = await readSlackThread({
      accessToken: "xoxb-bot",
      channelId: "C123",
      fetchImpl: fetchMock,
      limit: 50,
      threadTimestamp: "1.000001",
    });

    expect(page.nextCursor).toBeUndefined();
    const url = fetchMock.mock.calls[0]![0] as URL;
    expect(url.pathname).toBe("/api/conversations.replies");
    expect(url.searchParams.get("ts")).toBe("1.000001");
  });

  it("raises the Slack error code", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: "not_in_channel", ok: false }));

    await expect(readSlackChannelHistory({
      accessToken: "xoxb-bot",
      channelId: "C123",
      fetchImpl: fetchMock,
      limit: 10,
    })).rejects.toEqual(new SlackApiError("conversations.history", "not_in_channel"));
  });

  it("rejects malformed timestamps before calling Slack", async () => {
    const fetchMock = vi.fn();

    await expect(readSlackThread({
      accessToken: "xoxb-bot",
      channelId: "C123",
      fetchImpl: fetchMock,
      limit: 10,
      threadTimestamp: "latest",
    })).rejects.toThrow("Slack thread timestamp must be a message timestamp");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
