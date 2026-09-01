export const SLACK_CONTEXT_MCP_TOOLS = ["slack_search_channel"] as const;

export function slackContextToolAccess(input: {
  allowedChannelIds: ReadonlySet<string>;
  args: Record<string, unknown> | null;
  toolName: string;
}): { allowed: true } | { allowed: false; reason: string } {
  if (!(SLACK_CONTEXT_MCP_TOOLS as readonly string[]).includes(input.toolName)) {
    return { allowed: false, reason: "Slack context is read-only" };
  }

  const channelId = input.args?.channel_id;
  if (typeof channelId !== "string" || !input.allowedChannelIds.has(channelId)) {
    return {
      allowed: false,
      reason: "Slack channel is not selected for this agent",
    };
  }

  return { allowed: true };
}
