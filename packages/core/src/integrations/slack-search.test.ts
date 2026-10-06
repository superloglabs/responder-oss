import { describe, expect, it, vi } from "vitest";
import {
  normalizeSlackSearchQuery,
  searchSlackChannel,
  searchSlackChannels,
  SlackSearchError,
} from "./slack-search.js";

describe("Slack channel search", () => {
  it("scopes the query by channel name and drops results from other channels", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        ok: true,
        messages: {
          paging: { count: 10, page: 1, pages: 1, total: 2 },
          matches: [
            {
              channel: { id: "C123", name: "incidents" },
              permalink: "https://example.slack.com/archives/C123/p1",
              text: "database timeout in checkout",
              ts: "1.000001",
              user: "U123",
            },
            {
              channel: { id: "C999", name: "other" },
              permalink: "https://example.slack.com/archives/C999/p2",
              text: "must never cross the configured channel boundary",
              ts: "2.000002",
              username: "Example bot",
            },
          ],
        },
      }),
    );

    await expect(
      searchSlackChannel({
        accessToken: "xoxp-secret",
        channel: { id: "C123", name: "incidents" },
        fetchImpl: fetchMock,
        limit: 10,
        query: "  database   timeout  ",
      }),
    ).resolves.toEqual({
      channel: { id: "C123", name: "incidents" },
      matches: [
        {
          permalink: "https://example.slack.com/archives/C123/p1",
          text: "database timeout in checkout",
          timestamp: "1.000001",
          userId: "U123",
        },
      ],
      page: 1,
      pageCount: 1,
      query: "database timeout",
      total: 2,
      totalMatches: 1,
    });

    const url = new URL(fetchMock.mock.calls[0]![0] as URL);
    expect(url.origin + url.pathname).toBe(
      "https://slack.com/api/search.messages",
    );
    expect(url.searchParams.get("query")).toBe(
      "database timeout in:incidents",
    );
    expect(url.searchParams.get("count")).toBe("10");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: { authorization: "Bearer xoxp-secret" },
      }),
    );
  });

  it("searches several channels at once, scoped by Slack, and keeps only their matches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        ok: true,
        messages: {
          paging: { count: 50, page: 2, pages: 4, total: 180 },
          matches: [
            {
              channel: { id: "C456", name: "deploys" },
              permalink: "https://example.slack.com/archives/C456/p3?thread_ts=2.000001&cid=C456",
              text: "",
              ts: "3.000001",
              username: "CloudWatch",
              attachments: [
                { fallback: "ignored", title: "ALARM: checkout-5xx", text: "Threshold crossed" },
                { fallback: "Only a fallback" },
              ],
            },
            {
              channel: { id: "D123", name: "U999" },
              permalink: "https://example.slack.com/archives/D123/p4",
              text: "a direct message that must stay private",
              ts: "4.000001",
            },
          ],
        },
      }),
    );

    await expect(
      searchSlackChannels({
        accessToken: "xoxp-secret",
        channels: [
          { id: "C123", name: "incidents" },
          { id: "C456", name: "deploys" },
        ],
        fetchImpl: fetchMock,
        limit: 50,
        page: 2,
        query: "checkout from:@ana after:2026-01-31",
        sort: "score",
      }),
    ).resolves.toEqual({
      matches: [
        {
          channel: { id: "C456", name: "deploys" },
          permalink: "https://example.slack.com/archives/C456/p3?thread_ts=2.000001&cid=C456",
          text: "ALARM: checkout-5xx\nThreshold crossed\nOnly a fallback",
          threadTimestamp: "2.000001",
          timestamp: "3.000001",
          username: "CloudWatch",
        },
      ],
      page: 2,
      pageCount: 4,
      query: "checkout from:@ana after:2026-01-31",
      total: 180,
    });

    // Slack ORs repeated in: modifiers, so its totals and pages count only
    // these channels and say nothing about other conversations.
    const url = new URL(fetchMock.mock.calls[0]![0] as URL);
    expect(url.searchParams.get("query")).toBe(
      "checkout from:@ana after:2026-01-31 in:incidents in:deploys",
    );
    expect(url.searchParams.get("count")).toBe("50");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("sort")).toBe("score");
  });

  it("refuses to search more channels than one Slack query can scope", async () => {
    const fetchMock = vi.fn();
    const channels = Array.from({ length: 51 }, (_, index) => ({ id: `C${index}`, name: `channel-${index}` }));

    await expect(
      searchSlackChannels({ accessToken: "xoxp-secret", channels, fetchImpl: fetchMock, limit: 10, query: "timeout" }),
    ).rejects.toThrow("Slack search covers at most 50 channels at once");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects the in: modifier before making a request", async () => {
    const fetchMock = vi.fn();

    await expect(
      searchSlackChannel({
        accessToken: "xoxp-secret",
        channel: { id: "C123", name: "incidents" },
        fetchImpl: fetchMock,
        limit: 10,
        query: "timeout in:private-channel",
      }),
    ).rejects.toThrow("The Slack in: modifier is not allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces Slack rate limits without including credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(
        { ok: false, error: "ratelimited" },
        { status: 429, headers: { "retry-after": "30" } },
      ),
    );

    const error = await searchSlackChannel({
      accessToken: "xoxp-secret",
      channel: { id: "C123", name: "incidents" },
      fetchImpl: fetchMock,
      limit: 10,
      query: "timeout",
    }).catch((caught: unknown) => caught);

    expect(error).toEqual(
      expect.objectContaining<Partial<SlackSearchError>>({
        slackCode: "ratelimited",
        retryAfterSeconds: 30,
      }),
    );
    expect(String(error)).not.toContain("xoxp-secret");
  });

  it("normalizes equivalent whitespace for investigation-local caching", () => {
    expect(normalizeSlackSearchQuery("  checkout\n timeout ")).toBe(
      "checkout timeout",
    );
  });
});
