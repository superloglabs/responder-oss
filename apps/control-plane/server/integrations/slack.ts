import { z } from "zod";
import { integrationCallbackUrl } from "./urls.js";

const slackOAuthResponseSchema = z.object({
  ok: z.literal(true),
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  scope: z.string(),
  bot_user_id: z.string().min(1),
  app_id: z.string().min(1),
  team: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }),
  enterprise: z
    .object({
      id: z.string().nullable(),
      name: z.string().nullable(),
    })
    .nullable()
    .optional(),
  authed_user: z.object({
    id: z.string().min(1),
    access_token: z.string().min(1),
    token_type: z.string().min(1),
    scope: z.string(),
  }),
});

const slackChannelsResponseSchema = z.object({
  ok: z.literal(true),
  channels: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      is_archived: z.boolean().optional().default(false),
      is_member: z.boolean().optional().default(false),
      is_private: z.boolean().optional().default(false),
    }),
  ),
  response_metadata: z
    .object({ next_cursor: z.string().optional().default("") })
    .optional(),
});

const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "channels:join",
  "channels:history",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "groups:history",
  "groups:read",
  "reactions:write",
].join(",");

const SLACK_USER_SCOPES = "search:read";

export class SlackChannelJoinError extends Error {
  constructor(public readonly slackCode: string) {
    const message =
      slackCode === "missing_scope"
        ? "Reconnect Slack to let Responder join selected public channels automatically."
        : slackCode === "private_channel_invite_required"
          ? "Invite Responder to the selected private Slack channel."
          : `Unable to join the selected Slack channel (${slackCode}).`;
    super(message);
  }
}

function slackEnvironment() {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Slack application credentials are not configured");
  }
  return { clientId, clientSecret };
}

export function slackAuthorizeUrl(state: string): string {
  const { clientId } = slackEnvironment();
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", SLACK_BOT_SCOPES);
  url.searchParams.set("user_scope", SLACK_USER_SCOPES);
  url.searchParams.set("redirect_uri", integrationCallbackUrl("slack"));
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeSlackCode(code: string) {
  const { clientId, clientSecret } = slackEnvironment();
  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: integrationCallbackUrl("slack"),
    }),
  });
  const payload = await response.json();

  if (!response.ok || !payload || typeof payload !== "object" || !("ok" in payload)) {
    throw new Error("Slack OAuth token exchange failed");
  }
  if (payload.ok !== true) {
    const error = "error" in payload && typeof payload.error === "string"
      ? payload.error
      : "unknown_error";
    throw new Error(`Slack OAuth token exchange failed: ${error}`);
  }

  return slackOAuthResponseSchema.parse(payload);
}

export async function listSlackChannels(accessToken: string) {
  const channels: Array<{
    externalId: string;
    displayName: string;
    metadata: Record<string, unknown>;
  }> = [];
  let cursor = "";

  do {
    const url = new URL("https://slack.com/api/conversations.list");
    url.searchParams.set("types", "public_channel,private_channel");
    url.searchParams.set("exclude_archived", "true");
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const payload = await response.json();
    if (
      !response.ok ||
      !payload ||
      typeof payload !== "object" ||
      !("ok" in payload) ||
      payload.ok !== true
    ) {
      throw new Error("Unable to list Slack channels");
    }

    const page = slackChannelsResponseSchema.parse(payload);
    channels.push(
      ...page.channels
        .filter((channel) => !channel.is_archived)
        .map((channel) => ({
          externalId: channel.id,
          displayName: channel.name,
          metadata: {
            isMember: channel.is_member,
            isPrivate: channel.is_private,
          },
        })),
    );
    cursor = page.response_metadata?.next_cursor ?? "";
  } while (cursor);

  return channels;
}

export async function joinSlackChannel(
  accessToken: string,
  channelId: string,
): Promise<void> {
  const response = await fetch("https://slack.com/api/conversations.join", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ channel: channelId }),
  });
  const payload = await response.json().catch(() => null);
  if (
    !response.ok ||
    !payload ||
    typeof payload !== "object" ||
    !("ok" in payload) ||
    payload.ok !== true
  ) {
    const code =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `http_${response.status}`;
    throw new SlackChannelJoinError(code);
  }
}
