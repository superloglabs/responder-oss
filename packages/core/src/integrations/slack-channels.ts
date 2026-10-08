import { z } from "zod";
import { decryptCredentials } from "../credentials/encryption.js";
import {
  listConnectedIntegrationAccountCredentials,
  replaceIntegrationResourcesIfCredentialsMatch,
} from "../db/integrations.js";

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

const slackCredentialsSchema = z.object({
  accessToken: z.string().min(1),
});

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

// Replaces the cached channels of each connected Slack account, including
// whether the bot is a member of each. An account reconnected while Slack is
// queried keeps the channels listed with its new token.
export async function refreshSlackChannelResources(
  organizationId: string,
  listChannels: typeof listSlackChannels = listSlackChannels,
): Promise<void> {
  const accounts = await listConnectedIntegrationAccountCredentials(
    organizationId,
    "slack",
  );

  await Promise.all(
    accounts.map(async (account) => {
      const credentials = slackCredentialsSchema.parse(
        decryptCredentials<Record<string, unknown>>(
          account.encryptedCredentials!,
        ),
      );
      const channels = await listChannels(credentials.accessToken);
      await replaceIntegrationResourcesIfCredentialsMatch({
        encryptedCredentials: account.encryptedCredentials!,
        integrationAccountId: account.id,
        kind: "slack_channel",
        organizationId,
        provider: "slack",
        resources: channels,
      });
    }),
  );
}
