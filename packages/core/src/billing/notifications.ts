import { decryptCredentials } from "../credentials/encryption.js";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { getDatabase } from "../db/client.js";
import {
  agentConfigVersions,
  agents,
  billingNotificationDeliveries,
  integrationAccounts,
  integrationResources,
  type AgentTriggerConfig,
} from "../db/schema.js";

const RETRY_STALE_AFTER_MS = 5 * 60 * 1_000;

interface SlackAccount {
  accessToken: string;
  id: string;
  installerUserId: string | null;
}

interface SlackDestination {
  account: SlackAccount;
  channel: string;
  kind: "channel" | "installer_dm";
}

function billingUrl(): string | null {
  const configuredUrl = process.env.CONTROL_PLANE_URL ?? process.env.BETTER_AUTH_URL;
  if (!configuredUrl) return null;
  try {
    return new URL("/settings/billing", configuredUrl).toString();
  } catch {
    return null;
  }
}

export function billingLimitMessage(url = billingUrl()): string {
  const action = url
    ? ` Enable pay as you go ($1.50 per investigation) to resume: ${url}`
    : " Enable pay as you go ($1.50 per investigation) in Responder Billing to resume.";
  return `Responder has paused new investigations because this workspace used all 50 included investigations this month.${action}`;
}

async function slackAccounts(organizationId: string): Promise<SlackAccount[]> {
  const rows = await getDatabase()
    .select({
      encryptedCredentials: integrationAccounts.encryptedCredentials,
      id: integrationAccounts.id,
      metadata: integrationAccounts.metadata,
    })
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.organizationId, organizationId),
        eq(integrationAccounts.provider, "slack"),
        eq(integrationAccounts.status, "connected"),
      ),
    );

  return rows.flatMap((row) => {
    if (!row.encryptedCredentials) return [];
    const credentials = decryptCredentials<Record<string, unknown>>(
      row.encryptedCredentials,
    );
    if (typeof credentials.accessToken !== "string") return [];
    return [{
      accessToken: credentials.accessToken,
      id: row.id,
      installerUserId:
        typeof row.metadata.connectedBySlackUserId === "string"
          ? row.metadata.connectedBySlackUserId
          : null,
    }];
  });
}

function triggerChannels(
  trigger: "slack_channel" | "slack_mention",
  config: AgentTriggerConfig,
): { accountId: string; channelIds: string[] } | null {
  if (!("integrationAccountId" in config)) return null;
  if (trigger === "slack_channel" && "channelId" in config) {
    return { accountId: config.integrationAccountId, channelIds: [config.channelId] };
  }
  if (trigger === "slack_mention" && "channelIds" in config) {
    return { accountId: config.integrationAccountId, channelIds: config.channelIds };
  }
  return null;
}

export function watchedChannelIds(
  trigger: "slack_channel" | "slack_mention",
  configuredChannelIds: string[],
  availableChannelIds: string[],
): string[] {
  return trigger === "slack_mention" && configuredChannelIds.length === 0
    ? availableChannelIds
    : configuredChannelIds;
}

async function notificationDestinations(
  organizationId: string,
): Promise<SlackDestination[]> {
  const [accounts, triggerRows] = await Promise.all([
    slackAccounts(organizationId),
    getDatabase()
      .select({
        trigger: agentConfigVersions.trigger,
        triggerConfig: agentConfigVersions.triggerConfig,
      })
      .from(agents)
      .innerJoin(
        agentConfigVersions,
        eq(agentConfigVersions.id, agents.activeVersionId),
      )
      .where(
        and(
          eq(agents.organizationId, organizationId),
          eq(agents.enabled, true),
        ),
      ),
  ]);
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const resourceRows = accounts.length === 0
    ? []
    : await getDatabase()
        .select({
          accountId: integrationResources.integrationAccountId,
          channelId: integrationResources.externalId,
        })
        .from(integrationResources)
        .where(
          and(
            inArray(
              integrationResources.integrationAccountId,
              accounts.map((account) => account.id),
            ),
            eq(integrationResources.kind, "slack_channel"),
            eq(integrationResources.available, true),
          ),
        );
  const availableChannels = new Map<string, string[]>();
  for (const resource of resourceRows) {
    availableChannels.set(resource.accountId, [
      ...(availableChannels.get(resource.accountId) ?? []),
      resource.channelId,
    ]);
  }
  const destinations = new Map<string, SlackDestination>();

  for (const row of triggerRows) {
    if (row.trigger !== "slack_channel" && row.trigger !== "slack_mention") {
      continue;
    }
    const watched = triggerChannels(row.trigger, row.triggerConfig);
    const account = watched ? accountById.get(watched.accountId) : null;
    if (!watched || !account) continue;
    const watchedChannels = watchedChannelIds(
      row.trigger,
      watched.channelIds,
      availableChannels.get(account.id) ?? [],
    );
    for (const channel of watchedChannels) {
      destinations.set(`${account.id}:channel:${channel}`, {
        account,
        channel,
        kind: "channel",
      });
    }
  }

  for (const account of accounts) {
    if (!account.installerUserId) continue;
    destinations.set(`${account.id}:installer_dm:${account.installerUserId}`, {
      account,
      channel: account.installerUserId,
      kind: "installer_dm",
    });
  }

  return [...destinations.values()];
}

async function claimDelivery(
  organizationId: string,
  periodKey: string,
  destination: SlackDestination,
): Promise<string | null> {
  const db = getDatabase();
  const inserted = await db
    .insert(billingNotificationDeliveries)
    .values({
      organizationId,
      integrationAccountId: destination.account.id,
      periodKey,
      kind: destination.kind,
      destination: destination.channel,
    })
    .onConflictDoNothing()
    .returning({ id: billingNotificationDeliveries.id });
  if (inserted[0]) return inserted[0].id;

  const staleBefore = new Date(Date.now() - RETRY_STALE_AFTER_MS);
  const claimed = await db
    .update(billingNotificationDeliveries)
    .set({ status: "pending", lastError: null, updatedAt: new Date() })
    .where(
      and(
        eq(billingNotificationDeliveries.organizationId, organizationId),
        eq(billingNotificationDeliveries.periodKey, periodKey),
        eq(
          billingNotificationDeliveries.integrationAccountId,
          destination.account.id,
        ),
        eq(billingNotificationDeliveries.kind, destination.kind),
        eq(billingNotificationDeliveries.destination, destination.channel),
        or(
          eq(billingNotificationDeliveries.status, "failed"),
          and(
            eq(billingNotificationDeliveries.status, "pending"),
            lt(billingNotificationDeliveries.updatedAt, staleBefore),
          ),
        ),
      ),
    )
    .returning({ id: billingNotificationDeliveries.id });
  return claimed[0]?.id ?? null;
}

async function postSlackMessage(
  accessToken: string,
  channel: string,
  text: string,
): Promise<void> {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text, unfurl_links: false }),
  });
  const payload = await response.json().catch(() => null);
  if (
    !response.ok ||
    !payload ||
    typeof payload !== "object" ||
    !("ok" in payload) ||
    payload.ok !== true
  ) {
    const reason =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `HTTP ${response.status}`;
    throw new Error(`Slack message failed: ${reason}`);
  }
}

async function deliverNotification(
  organizationId: string,
  periodKey: string,
  destination: SlackDestination,
): Promise<void> {
  const deliveryId = await claimDelivery(organizationId, periodKey, destination);
  if (!deliveryId) return;

  try {
    await postSlackMessage(
      destination.account.accessToken,
      destination.channel,
      billingLimitMessage(),
    );
    await getDatabase()
      .update(billingNotificationDeliveries)
      .set({
        status: "sent",
        attemptCount: sql`${billingNotificationDeliveries.attemptCount} + 1`,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(billingNotificationDeliveries.id, deliveryId));
  } catch (error) {
    await getDatabase()
      .update(billingNotificationDeliveries)
      .set({
        status: "failed",
        attemptCount: sql`${billingNotificationDeliveries.attemptCount} + 1`,
        lastError: error instanceof Error ? error.message : "Unknown Slack error",
        updatedAt: new Date(),
      })
      .where(eq(billingNotificationDeliveries.id, deliveryId));
  }
}

export async function notifyBillingLimitReached(
  organizationId: string,
  nextResetAt: number | null,
): Promise<void> {
  const periodKey = nextResetAt
    ? `reset:${nextResetAt}`
    : `month:${new Date().toISOString().slice(0, 7)}`;
  const destinations = await notificationDestinations(organizationId);
  await Promise.all(
    destinations.map((destination) =>
      deliverNotification(organizationId, periodKey, destination),
    ),
  );
}
