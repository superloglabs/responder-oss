import { decryptCredentials } from "../credentials/encryption.js";
import { and, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { member, organization, user } from "../db/auth-schema.js";
import { getDatabase } from "../db/client.js";
import {
  agentConfigVersions,
  agents,
  billingNotificationDeliveries,
  integrationAccounts,
  integrationResources,
  type AgentTriggerConfig,
} from "../db/schema.js";
import { escapeHtml, sendEmail } from "../email.js";

const RETRY_STALE_AFTER_MS = 5 * 60 * 1_000;
// Resend keeps idempotency keys for 24 hours, so a delivery that failed after
// an uncertain response is retried only inside that window.
export const BILLING_NOTICE_RETRY_WINDOW_MS = 23 * 60 * 60 * 1_000;

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

interface EmailDestination {
  address: string;
  kind: "email";
}

type Destination = EmailDestination | SlackDestination;

function billingUrl(): string | null {
  const configuredUrl = process.env.CONTROL_PLANE_URL ?? process.env.BETTER_AUTH_URL;
  if (!configuredUrl) return null;
  try {
    return new URL("/settings/billing", configuredUrl).toString();
  } catch {
    return null;
  }
}

function limitSentence(usageBased: boolean): string {
  return usageBased
    ? "Superlog has paused new investigations and automation runs because this workspace used its included usage for this billing period. Work already in progress finishes, and new work resumes when the allowance resets."
    : "Superlog has paused new investigations because this workspace used all 50 included investigations this month.";
}

function limitAction(usageBased: boolean, url: string | null): string {
  if (usageBased) {
    return url
      ? `Upgrade the plan to resume now: ${url}`
      : "Upgrade the plan in Superlog Billing to resume now.";
  }
  return url
    ? `Enable pay as you go ($1.50 per investigation) to resume: ${url}`
    : "Enable pay as you go ($1.50 per investigation) in Superlog Billing to resume.";
}

export function billingLimitMessage(url = billingUrl(), usageBased = false): string {
  return `${limitSentence(usageBased)} ${limitAction(usageBased, url)}`;
}

export function billingLimitEmail(
  organizationName: string,
  usageBased: boolean,
  url = billingUrl(),
): { html: string; subject: string; text: string } {
  const sentence = limitSentence(usageBased);
  const action = url
    ? `<p><a href="${escapeHtml(url)}">${usageBased ? "Upgrade the plan" : "Enable pay as you go"}</a></p>`
    : `<p>${escapeHtml(limitAction(usageBased, null))}</p>`;
  return {
    html: `<p>Workspace: <strong>${escapeHtml(organizationName)}</strong></p>
<p>${escapeHtml(sentence)}</p>
${action}`,
    subject: `Superlog paused new work in ${organizationName}`,
    text: `Workspace: ${organizationName}\n\n${sentence}\n\n${limitAction(usageBased, url)}`,
  };
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
    // An unreadable Slack account must not stop email and other accounts.
    let credentials: Record<string, unknown>;
    try {
      credentials = decryptCredentials<Record<string, unknown>>(row.encryptedCredentials);
    } catch (error) {
      console.error(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        event: "billing_notice_slack_account_unreadable",
        integrationAccountId: row.id,
        organizationId,
      }));
      return [];
    }
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

// Slack's chat:write.public scope lets the bot post in public channels it has
// not joined, so notices are limited to channels where the bot is a member.
export function watchedChannelIds(
  trigger: "slack_channel" | "slack_mention",
  configuredChannelIds: string[],
  memberChannelIds: string[],
): string[] {
  if (trigger === "slack_mention" && configuredChannelIds.length === 0) {
    return memberChannelIds;
  }
  const members = new Set(memberChannelIds);
  return configuredChannelIds.filter((channelId) => members.has(channelId));
}

async function watchedChannelDestinations(
  organizationId: string,
  accounts: SlackAccount[],
): Promise<SlackDestination[]> {
  const triggerRows = await getDatabase()
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
    );
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const resourceRows = accounts.length === 0
    ? []
    : await getDatabase()
        .select({
          accountId: integrationResources.integrationAccountId,
          channelId: integrationResources.externalId,
          metadata: integrationResources.metadata,
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
  const memberChannels = new Map<string, string[]>();
  for (const resource of resourceRows) {
    if (resource.metadata.isMember !== true) continue;
    memberChannels.set(resource.accountId, [
      ...(memberChannels.get(resource.accountId) ?? []),
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
      memberChannels.get(account.id) ?? [],
    );
    for (const channel of watchedChannels) {
      destinations.set(`${account.id}:${channel}`, {
        account,
        channel,
        kind: "channel",
      });
    }
  }
  return [...destinations.values()];
}

// Workspace owners and admins can change the plan, so they receive email.
async function emailDestinations(organizationId: string): Promise<EmailDestination[]> {
  const rows = await getDatabase()
    .select({ email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(
        eq(member.organizationId, organizationId),
        inArray(member.role, ["owner", "admin"]),
      ),
    );
  const addresses = new Set(rows.map((row) => row.email.trim().toLowerCase()));
  return [...addresses].map((address) => ({ address, kind: "email" }));
}

async function notificationDestinations(
  organizationId: string,
): Promise<Destination[]> {
  const accounts = await slackAccounts(organizationId);
  const [channels, emails] = await Promise.all([
    watchedChannelDestinations(organizationId, accounts),
    emailDestinations(organizationId),
  ]);
  const directMessages = accounts.flatMap((account): SlackDestination[] =>
    account.installerUserId
      ? [{ account, channel: account.installerUserId, kind: "installer_dm" }]
      : [],
  );
  return [...channels, ...directMessages, ...emails];
}

function deliveryTarget(destination: Destination): {
  destination: string;
  integrationAccountId: string | null;
  kind: string;
} {
  return destination.kind === "email"
    ? { destination: destination.address, integrationAccountId: null, kind: "email" }
    : {
        destination: destination.channel,
        integrationAccountId: destination.account.id,
        kind: destination.kind,
      };
}

async function claimDelivery(
  organizationId: string,
  periodKey: string,
  destination: Destination,
): Promise<string | null> {
  const db = getDatabase();
  const target = deliveryTarget(destination);
  const inserted = await db
    .insert(billingNotificationDeliveries)
    .values({ organizationId, periodKey, ...target })
    .onConflictDoNothing()
    .returning({ id: billingNotificationDeliveries.id });
  if (inserted[0]) return inserted[0].id;

  const staleBefore = new Date(Date.now() - RETRY_STALE_AFTER_MS);
  const retryAfter = new Date(Date.now() - BILLING_NOTICE_RETRY_WINDOW_MS);
  const claimed = await db
    .update(billingNotificationDeliveries)
    .set({ status: "pending", lastError: null, updatedAt: new Date() })
    .where(
      and(
        eq(billingNotificationDeliveries.organizationId, organizationId),
        eq(billingNotificationDeliveries.periodKey, periodKey),
        target.integrationAccountId
          ? eq(billingNotificationDeliveries.integrationAccountId, target.integrationAccountId)
          : isNull(billingNotificationDeliveries.integrationAccountId),
        eq(billingNotificationDeliveries.kind, target.kind),
        eq(billingNotificationDeliveries.destination, target.destination),
        gt(billingNotificationDeliveries.createdAt, retryAfter),
        // A failed delivery waits as long as an abandoned claim before it is
        // tried again, so repeated blocked work does not retry it each time.
        inArray(billingNotificationDeliveries.status, ["failed", "pending"]),
        lt(billingNotificationDeliveries.updatedAt, staleBefore),
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

async function organizationName(organizationId: string): Promise<string> {
  const rows = await getDatabase()
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  return rows[0]?.name ?? "Your workspace";
}

async function deliverNotification(
  organizationId: string,
  periodKey: string,
  destination: Destination,
  usageBased: boolean,
  name: () => Promise<string>,
): Promise<void> {
  const deliveryId = await claimDelivery(organizationId, periodKey, destination);
  if (!deliveryId) return;

  try {
    if (destination.kind === "email") {
      const sent = await sendEmail({
        ...billingLimitEmail(await name(), usageBased),
        idempotencyKey: `billing-notice/${deliveryId}`,
        to: destination.address,
      });
      if (!sent) throw new Error("Email is not configured");
    } else {
      await postSlackMessage(
        destination.account.accessToken,
        destination.channel,
        billingLimitMessage(undefined, usageBased),
      );
    }
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
    const message = error instanceof Error ? error.message : "Unknown delivery error";
    console.error(JSON.stringify({
      deliveryId,
      error: message,
      event: "billing_notice_delivery_failed",
      kind: destination.kind,
      organizationId,
    }));
    await getDatabase()
      .update(billingNotificationDeliveries)
      .set({
        status: "failed",
        attemptCount: sql`${billingNotificationDeliveries.attemptCount} + 1`,
        lastError: message,
        updatedAt: new Date(),
      })
      .where(eq(billingNotificationDeliveries.id, deliveryId));
  }
}

async function hasDeliveriesForPeriod(
  organizationId: string,
  periodKey: string,
): Promise<boolean> {
  const rows = await getDatabase()
    .select({ id: billingNotificationDeliveries.id })
    .from(billingNotificationDeliveries)
    .where(
      and(
        eq(billingNotificationDeliveries.organizationId, organizationId),
        eq(billingNotificationDeliveries.periodKey, periodKey),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// Each destination receives the notice once per billing period.
export function billingLimitPeriodKey(
  nextResetAt: number | null,
  now = new Date(),
): string {
  return nextResetAt
    ? `reset:${nextResetAt}`
    : `month:${now.toISOString().slice(0, 7)}`;
}

export async function notifyBillingLimitReached(
  organizationId: string,
  nextResetAt: number | null,
  options: {
    refreshSlackChannels?: (organizationId: string) => Promise<void>;
    usageBased?: boolean;
  } = {},
): Promise<void> {
  const periodKey = billingLimitPeriodKey(nextResetAt);
  const usageBased = options.usageBased ?? false;
  // Channel membership is cached, so refresh it once before the first notice
  // of a period rather than on every blocked investigation. If the refresh
  // fails, send nothing so the next blocked investigation retries both.
  if (
    options.refreshSlackChannels &&
    !(await hasDeliveriesForPeriod(organizationId, periodKey))
  ) {
    try {
      await options.refreshSlackChannels(organizationId);
    } catch (error) {
      console.error("Unable to refresh Slack channels for billing notices", error);
      return;
    }
  }
  const destinations = await notificationDestinations(organizationId);
  let name: Promise<string> | undefined;
  const lookupName = () => (name ??= organizationName(organizationId));
  await Promise.all(
    destinations.map((destination) =>
      deliverNotification(organizationId, periodKey, destination, usageBased, lookupName),
    ),
  );
}
