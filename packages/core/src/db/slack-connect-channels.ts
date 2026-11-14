import { eq } from "drizzle-orm";
import { user } from "./auth-schema.js";
import { getDatabase } from "./client.js";
import { slackConnectChannels } from "./schema.js";

export { getOrganizationName } from "./organizations.js";

export type SlackConnectChannel = typeof slackConnectChannels.$inferSelect;
export type SlackConnectChannelStatus = SlackConnectChannel["status"];

// Returns the workspace's Slack Connect channel row, creating a pending one
// the first time.
export async function claimSlackConnectChannel(
  organizationId: string,
): Promise<SlackConnectChannel> {
  const database = getDatabase();
  await database
    .insert(slackConnectChannels)
    .values({ organizationId })
    .onConflictDoNothing();
  const rows = await database
    .select()
    .from(slackConnectChannels)
    .where(eq(slackConnectChannels.organizationId, organizationId))
    .limit(1);
  if (!rows[0]) throw new Error("The Slack Connect channel row was not created");
  return rows[0];
}

export async function updateSlackConnectChannel(
  organizationId: string,
  patch: Partial<
    Pick<
      SlackConnectChannel,
      "channelId" | "channelName" | "lastError" | "status" | "workspaceChannelId"
    >
  >,
): Promise<void> {
  await getDatabase()
    .update(slackConnectChannels)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(slackConnectChannels.organizationId, organizationId));
}

export async function getUserEmail(userId: string): Promise<string | null> {
  const rows = await getDatabase()
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows[0]?.email ?? null;
}
