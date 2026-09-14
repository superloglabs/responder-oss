import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSlackConnection } from "@responder/core/db/investigations";
import { searchSlackChannel } from "@responder/core/integrations/slack-search";
import { SlackSearchMcpServer } from "./slack.js";

const activeSpan = vi.hoisted(() => ({
  recordException: vi.fn(),
  setStatus: vi.fn(),
}));

vi.mock("@opentelemetry/api", () => ({
  SpanStatusCode: { ERROR: 2 },
  trace: { getActiveSpan: () => activeSpan },
}));
vi.mock("@responder/core/integrations/slack-search", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@responder/core/integrations/slack-search")
  >();
  return { ...original, searchSlackChannel: vi.fn() };
});

const connection: RuntimeSlackConnection = {
  accountId: "account-1",
  channels: [
    { id: "C123", name: "incidents" },
    { id: "C456", name: "engineering" },
  ],
  userAccessToken: "user-token",
};

const searchResult = {
  channel: { id: "C123", name: "incidents" },
  matches: [
    {
      permalink: "https://example.slack.com/archives/C123/p1",
      text: "database timeout",
      timestamp: "1.000001",
      userId: "U123",
    },
  ],
  query: "database timeout",
  totalMatches: 1,
};

describe("Slack channel search server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes one search tool with the selected channel IDs", async () => {
    const server = new SlackSearchMcpServer(connection);

    await expect(server.listTools()).resolves.toEqual([
      expect.objectContaining({
        name: "slack_search_channel",
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            channel_id: expect.objectContaining({ enum: ["C123", "C456"] }),
          }),
        }),
      }),
    ]);
  });

  it("searches a selected channel with normalized arguments", async () => {
    vi.mocked(searchSlackChannel).mockResolvedValue(searchResult);
    const server = new SlackSearchMcpServer(connection);

    await expect(
      server.callTool("slack_search_channel", {
        channel_id: "C123",
        query: "  database   timeout ",
      }),
    ).resolves.toEqual([
      { type: "text", text: JSON.stringify(searchResult) },
    ]);
    expect(searchSlackChannel).toHaveBeenCalledWith({
      accessToken: "user-token",
      channel: { id: "C123", name: "incidents" },
      limit: 10,
      query: "database timeout",
      signal: undefined,
    });
  });

  it("reuses identical searches within an investigation", async () => {
    vi.mocked(searchSlackChannel).mockResolvedValue(searchResult);
    const server = new SlackSearchMcpServer(connection);
    const args = { channel_id: "C123", limit: 10, query: "database timeout" };

    await server.callTool("slack_search_channel", args);
    await server.callTool("slack_search_channel", args);

    expect(searchSlackChannel).toHaveBeenCalledTimes(1);
  });

  it("removes failed searches from the investigation cache", async () => {
    vi.mocked(searchSlackChannel)
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(searchResult);
    const server = new SlackSearchMcpServer(connection);
    const args = { channel_id: "C123", query: "database timeout" };

    await expect(
      server.callTool("slack_search_channel", args),
    ).rejects.toThrow("temporary failure");
    await expect(
      server.callTool("slack_search_channel", args),
    ).resolves.toBeDefined();

    expect(searchSlackChannel).toHaveBeenCalledTimes(2);
  });

  it("blocks unselected channels before calling Slack", async () => {
    const server = new SlackSearchMcpServer(connection);
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      server.callTool("slack_search_channel", {
        channel_id: "C999",
        query: "database timeout",
      }),
    ).rejects.toThrow("Slack channel is not selected");
    expect(searchSlackChannel).not.toHaveBeenCalled();
    expect(activeSpan.recordException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Slack channel is not selected for this agent",
      }),
    );
    expect(logError).toHaveBeenCalledWith(
      JSON.stringify({
        event: "slack_search_tool_blocked",
        reason: "Slack channel is not selected for this agent",
        serverName: "slack-account-1",
        toolName: "slack_search_channel",
      }),
    );
  });
});
