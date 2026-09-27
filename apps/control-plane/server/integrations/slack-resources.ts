import { z } from "zod";
import { decryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import {
  listConnectedIntegrationAccountCredentials,
  replaceIntegrationResources,
} from "../../../../packages/core/src/db/integrations.js";
import { listSlackChannels } from "./slack.js";

const slackCredentialsSchema = z.object({
  accessToken: z.string().min(1),
});

export async function refreshSlackChannelResources(
  organizationId: string,
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
      const channels = await listSlackChannels(credentials.accessToken);
      await replaceIntegrationResources(
        account.id,
        "slack_channel",
        channels,
      );
    }),
  );
}
