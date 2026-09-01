import { describe, expect, it, vi } from "vitest";
import {
  normalizeSlackSearchQuery,
  searchSlackChannel,
  SlackSearchError,
} from "./slack-search.js";

describe("Slack channel search", () => {
  it("scopes the query by channel name and drops results from other channels", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        ok: true,
        messages: {
          total: 2,
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
      query: "database timeout",
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

  it("rejects Slack search modifiers before making a request", async () => {
    const fetchMock = vi.fn();

    await expect(
      searchSlackChannel({
        accessToken: "xoxp-secret",
        channel: { id: "C123", name: "incidents" },
        fetchImpl: fetchMock,
        limit: 10,
        query: "timeout in:private-channel",
      }),
    ).rejects.toThrow("Slack search modifiers are not allowed");
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
