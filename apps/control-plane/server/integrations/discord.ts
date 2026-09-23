import { z } from "zod";
import { integrationCallbackUrl } from "./urls.js";

const discordOAuthResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  guild: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }),
  refresh_token: z.string().min(1),
  scope: z.string(),
  token_type: z.string().min(1),
});

const discordChannelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  position: z.number().int().optional().default(0),
  type: z.number().int(),
});

function discordEnvironment() {
  const applicationId = process.env.DISCORD_APPLICATION_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!applicationId || !botToken || !clientSecret) {
    throw new Error("Discord application credentials are not configured");
  }
  return { applicationId, botToken, clientSecret };
}

function discordApiUrl(path: string): string {
  return `https://discord.com/api/v10${path}`;
}

export function discordAuthorizeUrl(state: string): string {
  const { applicationId } = discordEnvironment();
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", applicationId);
  url.searchParams.set("redirect_uri", integrationCallbackUrl("discord"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify applications.commands bot");
  url.searchParams.set("permissions", "1024");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeDiscordCode(code: string) {
  const { applicationId, clientSecret } = discordEnvironment();
  const response = await fetch(discordApiUrl("/oauth2/token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: applicationId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: integrationCallbackUrl("discord"),
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error("Discord OAuth token exchange failed");
  return discordOAuthResponseSchema.parse(payload);
}

export async function listDiscordChannels(guildId: string) {
  const { botToken } = discordEnvironment();
  const response = await fetch(
    discordApiUrl(`/guilds/${encodeURIComponent(guildId)}/channels`),
    { headers: { authorization: `Bot ${botToken}` } },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error("Unable to list Discord channels");
  const channels = z.array(discordChannelSchema).parse(payload);
  return channels
    .filter((channel) => channel.type === 0 || channel.type === 5)
    .sort((left, right) => left.position - right.position)
    .map((channel) => ({
      displayName: channel.name,
      externalId: channel.id,
      metadata: { type: channel.type },
    }));
}

export async function registerDiscordAutomationCommand(
  guildId: string,
): Promise<void> {
  const { applicationId, botToken } = discordEnvironment();
  const response = await fetch(
    discordApiUrl(
      `/applications/${encodeURIComponent(applicationId)}/guilds/${encodeURIComponent(guildId)}/commands`,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bot ${botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "automate",
        description: "Start configured Responder automations in this channel",
        options: [
          {
            description: "Optional context to include with the trigger",
            name: "context",
            required: false,
            type: 3,
          },
        ],
        contexts: [0],
        integration_types: [0],
        type: 1,
      }),
    },
  );
  if (!response.ok) {
    throw new Error("Unable to register the Discord automation command");
  }
}
