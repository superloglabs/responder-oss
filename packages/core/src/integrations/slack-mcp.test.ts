import { describe, expect, it } from "vitest";
import { slackContextToolAccess } from "./slack-mcp.js";

const allowedChannelIds = new Set(["C123", "C456"]);

describe("Slack MCP context scope", () => {
  it("allows searches for selected channels", () => {
    expect(
      slackContextToolAccess({
        allowedChannelIds,
        args: { channel_id: "C123" },
        toolName: "slack_search_channel",
      }),
    ).toEqual({ allowed: true });
  });

  it("rejects reads from unselected channels", () => {
    expect(
      slackContextToolAccess({
        allowedChannelIds,
        args: { channel_id: "C999" },
        toolName: "slack_search_channel",
      }),
    ).toEqual({
      allowed: false,
      reason: "Slack channel is not selected for this agent",
    });
  });

  it("rejects write and discovery tools", () => {
    expect(
      slackContextToolAccess({
        allowedChannelIds,
        args: { channel_id: "C123" },
        toolName: "slack_read_channel",
      }),
    ).toEqual({ allowed: false, reason: "Slack context is read-only" });
  });
});
