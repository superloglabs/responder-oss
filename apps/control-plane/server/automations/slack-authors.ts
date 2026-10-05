import { z } from "zod";
import { decryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import {
  listSlackMessageAuthors,
  nameSlackMessageAuthors,
} from "../../../../packages/core/src/db/automations.js";
import { getOrganizationIntegrationAccount } from "../../../../packages/core/src/db/integrations.js";
import { getSlackAuthorName, SlackApiError } from "../../../../packages/core/src/integrations/slack.js";

const slackCredentialsSchema = z.object({ accessToken: z.string().min(1) });
// Slack limits bots.info to about 50 calls a minute, so one load names this
// many authors and the next load names the rest.
const lookupsPerLoad = 20;

// The people and apps that posted in the channels, with the names Slack shows
// for those recorded only under their IDs. Looking a name up needs the
// users:read scope. Without it, those authors keep their IDs and
// `namesNeedReconnect` says that reconnecting Slack would name them.
export async function listNamedSlackAuthors(input: {
  channelIds: string[];
  integrationAccountId: string;
  organizationId: string;
}): Promise<{
  authors: Array<{ id: string; kind: "app" | "person"; name: string }>;
  namesNeedReconnect: boolean;
}> {
  const authors = await listSlackMessageAuthors(input);
  // App IDs have no lookup. Their messages always carry the app's name.
  const unnamed = authors.filter((author) => author.name === author.id && /^[BUW]/u.test(author.id));
  if (unnamed.length === 0) return { authors, namesNeedReconnect: false };
  const account = await getOrganizationIntegrationAccount({
    integrationAccountId: input.integrationAccountId,
    organizationId: input.organizationId,
    provider: "slack",
  });
  const scopes = account?.metadata.scopes;
  if (
    account?.status !== "connected" ||
    !account.encryptedCredentials ||
    !Array.isArray(scopes) ||
    !scopes.includes("users:read")
  ) {
    return { authors, namesNeedReconnect: true };
  }
  const { accessToken } = slackCredentialsSchema.parse(
    decryptCredentials<Record<string, unknown>>(account.encryptedCredentials),
  );
  const lookups = await Promise.allSettled(
    unnamed.slice(0, lookupsPerLoad).map(async (author) => ({
      id: author.id,
      name: await getSlackAuthorName({ accessToken, id: author.id }),
    })),
  );
  const names = lookups.flatMap((lookup) =>
    lookup.status === "fulfilled" && lookup.value.name ? [{ id: lookup.value.id, name: lookup.value.name }] : []
  );
  const failures = lookups.flatMap((lookup) => lookup.status === "rejected" ? [lookup.reason as unknown] : []);
  if (failures.length > 0) {
    console.error(JSON.stringify({
      errorCodes: [...new Set(failures.map((error) => error instanceof SlackApiError ? error.code : "unknown"))],
      event: "slack_author_name_lookup_failed",
      failedCount: failures.length,
      integrationAccountId: input.integrationAccountId,
    }));
  }
  if (names.length > 0) {
    // A failed save only means the next load looks the names up again.
    await nameSlackMessageAuthors({ integrationAccountId: input.integrationAccountId, names }).catch((error: unknown) => {
      console.error(JSON.stringify({
        errorCode: error instanceof Error ? error.name : typeof error,
        event: "slack_author_name_save_failed",
        integrationAccountId: input.integrationAccountId,
      }));
    });
  }
  return {
    authors: authors.map((author) => ({
      ...author,
      name: names.find((named) => named.id === author.id)?.name ?? author.name,
    })),
    // A connection whose scope was taken away since it was saved.
    namesNeedReconnect: failures.some((error) => error instanceof SlackApiError && error.code === "missing_scope"),
  };
}
