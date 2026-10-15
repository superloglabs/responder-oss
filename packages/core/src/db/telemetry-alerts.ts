import { and, asc, count, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import type { AlertCreate, AlertRule, AlertSlackTarget, AlertUpdate } from "../telemetry/alerts.js";
import { getDatabase } from "./client.js";
import {
  integrationAccounts,
  integrationResources,
  organizationCapabilities,
  telemetryAlertEpisodes,
  telemetryAlerts,
} from "./schema.js";

export type TelemetryAlert = AlertRule & {
  createdAt: string;
  enabled: boolean;
  evaluationIntervalSeconds: number;
  id: string;
  lastError: string | null;
  lastEvaluatedAt: string | null;
  name: string;
  slack: AlertSlackTarget | null;
  updatedAt: string;
};

export type TelemetryAlertSummary = TelemetryAlert & { firingGroups: number };

export type TelemetryAlertEpisode = {
  endedAt: string | null;
  groupKey: string;
  id: string;
  lastValue: number;
  openValue: number;
  peakValue: number;
  startedAt: string;
  state: "firing" | "resolved";
};

const alertColumns = {
  aggregation: telemetryAlerts.aggregation,
  comparator: telemetryAlerts.comparator,
  createdAt: telemetryAlerts.createdAt,
  enabled: telemetryAlerts.enabled,
  evaluationIntervalSeconds: telemetryAlerts.evaluationIntervalSeconds,
  filter: telemetryAlerts.filter,
  groupBy: telemetryAlerts.groupBy,
  groupMode: telemetryAlerts.groupMode,
  id: telemetryAlerts.id,
  lastError: telemetryAlerts.lastError,
  lastEvaluatedAt: telemetryAlerts.lastEvaluatedAt,
  metricName: telemetryAlerts.metricName,
  name: telemetryAlerts.name,
  slackChannelId: telemetryAlerts.slackChannelId,
  slackIntegrationAccountId: telemetryAlerts.slackIntegrationAccountId,
  source: telemetryAlerts.source,
  threshold: telemetryAlerts.threshold,
  updatedAt: telemetryAlerts.updatedAt,
  windowMinutes: telemetryAlerts.windowMinutes,
};

type AlertRow = Omit<TelemetryAlert, "createdAt" | "lastEvaluatedAt" | "slack" | "updatedAt"> & {
  createdAt: Date;
  lastEvaluatedAt: Date | null;
  slackChannelId: string | null;
  slackIntegrationAccountId: string | null;
  updatedAt: Date;
};

function toAlert(row: AlertRow): TelemetryAlert {
  const { slackChannelId, slackIntegrationAccountId, ...rest } = row;
  return {
    ...rest,
    createdAt: row.createdAt.toISOString(),
    lastEvaluatedAt: row.lastEvaluatedAt?.toISOString() ?? null,
    slack:
      slackChannelId && slackIntegrationAccountId
        ? { channelId: slackChannelId, integrationAccountId: slackIntegrationAccountId }
        : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listTelemetryAlerts(organizationId: string): Promise<TelemetryAlertSummary[]> {
  const firing = getDatabase()
    .select({ alertId: telemetryAlertEpisodes.alertId, firingGroups: count().as("firing_groups") })
    .from(telemetryAlertEpisodes)
    .where(eq(telemetryAlertEpisodes.state, "firing"))
    .groupBy(telemetryAlertEpisodes.alertId)
    .as("firing");
  const rows = await getDatabase()
    .select({ ...alertColumns, firingGroups: firing.firingGroups })
    .from(telemetryAlerts)
    .leftJoin(firing, eq(firing.alertId, telemetryAlerts.id))
    .where(eq(telemetryAlerts.organizationId, organizationId))
    .orderBy(asc(telemetryAlerts.name), asc(telemetryAlerts.id));
  return rows.map(({ firingGroups, ...row }) => ({ ...toAlert(row), firingGroups: Number(firingGroups ?? 0) }));
}

export async function findTelemetryAlert(organizationId: string, alertId: string): Promise<TelemetryAlert | null> {
  const rows = await getDatabase()
    .select(alertColumns)
    .from(telemetryAlerts)
    .where(and(eq(telemetryAlerts.organizationId, organizationId), eq(telemetryAlerts.id, alertId)))
    .limit(1);
  return rows[0] ? toAlert(rows[0]) : null;
}

export async function listTelemetryAlertEpisodes(alertId: string, limit = 50): Promise<TelemetryAlertEpisode[]> {
  const rows = await getDatabase()
    .select({
      endedAt: telemetryAlertEpisodes.endedAt,
      groupKey: telemetryAlertEpisodes.groupKey,
      id: telemetryAlertEpisodes.id,
      lastValue: telemetryAlertEpisodes.lastValue,
      openValue: telemetryAlertEpisodes.openValue,
      peakValue: telemetryAlertEpisodes.peakValue,
      startedAt: telemetryAlertEpisodes.startedAt,
      state: telemetryAlertEpisodes.state,
    })
    .from(telemetryAlertEpisodes)
    .where(eq(telemetryAlertEpisodes.alertId, alertId))
    .orderBy(desc(telemetryAlertEpisodes.startedAt), desc(telemetryAlertEpisodes.id))
    .limit(limit);
  return rows.map((row) => ({
    ...row,
    endedAt: row.endedAt?.toISOString() ?? null,
    startedAt: row.startedAt.toISOString(),
  }));
}

function ruleValues(input: AlertUpdate) {
  return {
    aggregation: input.aggregation,
    comparator: input.comparator,
    enabled: input.enabled,
    evaluationIntervalSeconds: input.evaluationIntervalSeconds,
    filter: input.filter,
    groupBy: input.groupBy,
    groupMode: input.groupMode,
    metricName: input.metricName,
    name: input.name,
    slackChannelId: input.slack?.channelId ?? null,
    slackIntegrationAccountId: input.slack?.integrationAccountId ?? null,
    source: input.source,
    threshold: input.threshold,
    windowMinutes: input.windowMinutes,
  };
}

export async function createTelemetryAlert(
  organizationId: string,
  input: AlertCreate & { createdBy: string },
): Promise<TelemetryAlert> {
  const [row] = await getDatabase()
    .insert(telemetryAlerts)
    .values({ ...ruleValues(input), createdBy: input.createdBy, organizationId })
    .returning(alertColumns);
  return toAlert(row!);
}

// Ends open episodes without posting a recovery, for a rule that changed or
// stopped being checked.
async function endOpenEpisodes(executor: Pick<ReturnType<typeof getDatabase>, "update">, alertId: string) {
  const now = new Date();
  await executor
    .update(telemetryAlertEpisodes)
    .set({ endedAt: now, recoveryNotifiedAt: now, state: "resolved", updatedAt: now })
    .where(and(eq(telemetryAlertEpisodes.alertId, alertId), eq(telemetryAlertEpisodes.state, "firing")));
}

// Equal values, ignoring object key order, which jsonb does not keep.
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const defined = (value: object) => Object.entries(value).filter(([, item]) => item !== undefined);
    const left = defined(a);
    const right = new Map(defined(b));
    return left.length === right.size && left.every(([key, item]) => right.has(key) && sameValue(item, right.get(key)));
  }
  return false;
}

const evaluatedFields = [
  "aggregation",
  "comparator",
  "filter",
  "groupBy",
  "groupMode",
  "metricName",
  "source",
  "threshold",
  "windowMinutes",
] as const;

// Replaces the rule. Changing what is evaluated, or disabling the alert,
// ends its open episodes; the next check opens new ones where it still
// breaches.
export async function updateTelemetryAlert(
  organizationId: string,
  alertId: string,
  input: AlertUpdate,
): Promise<TelemetryAlert | null> {
  const current = await findTelemetryAlert(organizationId, alertId);
  if (!current) return null;
  const evaluationChanged = evaluatedFields.some((field) => !sameValue(current[field], input[field]));
  await getDatabase().transaction(async (transaction) => {
    await transaction
      .update(telemetryAlerts)
      .set({
        ...ruleValues(input),
        lastError: evaluationChanged ? null : current.lastError,
        ...(evaluationChanged ? { lastEvaluatedAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(telemetryAlerts.organizationId, organizationId), eq(telemetryAlerts.id, alertId)));
    if (evaluationChanged || !input.enabled) await endOpenEpisodes(transaction, alertId);
  });
  return findTelemetryAlert(organizationId, alertId);
}

export async function deleteTelemetryAlert(organizationId: string, alertId: string): Promise<boolean> {
  if (!(await findTelemetryAlert(organizationId, alertId))) return false;
  const deleted = await getDatabase()
    .delete(telemetryAlerts)
    .where(and(eq(telemetryAlerts.organizationId, organizationId), eq(telemetryAlerts.id, alertId)))
    .returning({ id: telemetryAlerts.id });
  return deleted.length > 0;
}

export type DueTelemetryAlert = TelemetryAlert & { organizationId: string };

// Claims enabled alerts whose interval has passed, for workspaces that can
// use alerts. Claiming stamps the check time, so
// another worker skips them; a failed check waits for the next interval.
export async function claimDueTelemetryAlerts(limit: number): Promise<DueTelemetryAlert[]> {
  const result = await getDatabase().execute<{
    aggregation: AlertRule["aggregation"];
    comparator: AlertRule["comparator"];
    created_at: Date | string;
    enabled: boolean;
    evaluation_interval_seconds: number;
    filter: AlertRule["filter"];
    group_by: string | null;
    group_mode: AlertRule["groupMode"];
    id: string;
    last_error: string | null;
    last_evaluated_at: Date | string | null;
    metric_name: string | null;
    name: string;
    organization_id: string;
    slack_channel_id: string | null;
    slack_integration_account_id: string | null;
    source: AlertRule["source"];
    threshold: number;
    updated_at: Date | string;
    window_minutes: number;
  }>(sql`
    update ${telemetryAlerts} set last_evaluated_at = now()
    where ${telemetryAlerts.id} in (
      select alert.id from ${telemetryAlerts} alert
      join ${organizationCapabilities} telemetry
        on telemetry.organization_id = alert.organization_id and telemetry.capability = 'telemetry' and telemetry.enabled
      join ${organizationCapabilities} alerts
        on alerts.organization_id = alert.organization_id and alerts.capability = 'alerts' and alerts.enabled
      where alert.enabled
        and (alert.last_evaluated_at is null
          or alert.last_evaluated_at <= now() - make_interval(secs => alert.evaluation_interval_seconds))
      order by alert.last_evaluated_at asc nulls first
      limit ${limit}
      for update of alert skip locked
    )
    returning *
  `);
  const time = (value: Date | string) => new Date(value).toISOString();
  return result.rows.map((row) => ({
    aggregation: row.aggregation,
    comparator: row.comparator,
    createdAt: time(row.created_at),
    enabled: row.enabled,
    evaluationIntervalSeconds: row.evaluation_interval_seconds,
    filter: row.filter,
    groupBy: row.group_by,
    groupMode: row.group_mode,
    id: row.id,
    lastError: row.last_error,
    lastEvaluatedAt: row.last_evaluated_at ? time(row.last_evaluated_at) : null,
    metricName: row.metric_name,
    name: row.name,
    organizationId: row.organization_id,
    slack:
      row.slack_channel_id && row.slack_integration_account_id
        ? { channelId: row.slack_channel_id, integrationAccountId: row.slack_integration_account_id }
        : null,
    source: row.source,
    threshold: Number(row.threshold),
    updatedAt: time(row.updated_at),
    windowMinutes: row.window_minutes,
  }));
}

export async function recordTelemetryAlertCheck(alertId: string, error: string | null): Promise<void> {
  await getDatabase().update(telemetryAlerts).set({ lastError: error }).where(eq(telemetryAlerts.id, alertId));
}

export type OpenTelemetryAlertEpisode = {
  groupKey: string;
  id: string;
  peakValue: number;
  slackChannelId: string | null;
  slackIntegrationAccountId: string | null;
  slackMessageTs: string | null;
  startedAt: Date;
};

const openEpisodeColumns = {
  groupKey: telemetryAlertEpisodes.groupKey,
  id: telemetryAlertEpisodes.id,
  peakValue: telemetryAlertEpisodes.peakValue,
  slackChannelId: telemetryAlertEpisodes.slackChannelId,
  slackIntegrationAccountId: telemetryAlertEpisodes.slackIntegrationAccountId,
  slackMessageTs: telemetryAlertEpisodes.slackMessageTs,
  startedAt: telemetryAlertEpisodes.startedAt,
};

export async function openTelemetryAlertEpisodes(alertId: string): Promise<OpenTelemetryAlertEpisode[]> {
  return getDatabase()
    .select(openEpisodeColumns)
    .from(telemetryAlertEpisodes)
    .where(and(eq(telemetryAlertEpisodes.alertId, alertId), eq(telemetryAlertEpisodes.state, "firing")));
}

// Null when the group already has an open episode, or when the alert was
// disabled or changed since `ruleUpdatedAt`, the version the check used.
export async function openTelemetryAlertEpisode(input: {
  alertId: string;
  groupKey: string;
  ruleUpdatedAt: string;
  slack: AlertSlackTarget | null;
  value: number;
}): Promise<OpenTelemetryAlertEpisode | null> {
  const result = await getDatabase().execute<{
    group_key: string;
    id: string;
    peak_value: number;
    slack_channel_id: string | null;
    slack_integration_account_id: string | null;
    slack_message_ts: string | null;
    started_at: Date | string;
  }>(sql`
    insert into ${telemetryAlertEpisodes}
      (alert_id, group_key, open_value, peak_value, last_value, slack_channel_id, slack_integration_account_id)
    select ${input.alertId}, ${input.groupKey}, ${input.value}, ${input.value}, ${input.value},
      ${input.slack?.channelId ?? null}, ${input.slack?.integrationAccountId ?? null}
    where exists (
      select 1 from ${telemetryAlerts}
      where ${telemetryAlerts.id} = ${input.alertId}
        and ${telemetryAlerts.enabled}
        -- The version is read back in JavaScript, which keeps milliseconds.
        and date_trunc('milliseconds', ${telemetryAlerts.updatedAt}) = ${input.ruleUpdatedAt}::timestamptz
    )
    on conflict do nothing
    returning id, group_key, peak_value, slack_channel_id, slack_integration_account_id, slack_message_ts, started_at
  `);
  const row = result.rows[0];
  return row
    ? {
        groupKey: row.group_key,
        id: row.id,
        peakValue: Number(row.peak_value),
        slackChannelId: row.slack_channel_id,
        slackIntegrationAccountId: row.slack_integration_account_id,
        slackMessageTs: row.slack_message_ts,
        startedAt: new Date(row.started_at),
      }
    : null;
}

// The peak is compared in the update, so overlapping checks keep the worst.
export async function continueTelemetryAlertEpisode(
  episode: Pick<OpenTelemetryAlertEpisode, "id">,
  comparator: AlertRule["comparator"],
  value: number,
): Promise<void> {
  const peak =
    comparator === "gt"
      ? sql`greatest(${telemetryAlertEpisodes.peakValue}, ${value})`
      : sql`least(${telemetryAlertEpisodes.peakValue}, ${value})`;
  await getDatabase()
    .update(telemetryAlertEpisodes)
    .set({ lastValue: value, peakValue: peak, updatedAt: new Date() })
    .where(and(eq(telemetryAlertEpisodes.id, episode.id), eq(telemetryAlertEpisodes.state, "firing")));
}

// False when the episode was already ended, by an edit or another worker.
export async function resolveTelemetryAlertEpisode(episodeId: string, value: number): Promise<boolean> {
  const now = new Date();
  const rows = await getDatabase()
    .update(telemetryAlertEpisodes)
    .set({ endedAt: now, lastValue: value, state: "resolved", updatedAt: now })
    .where(and(eq(telemetryAlertEpisodes.id, episodeId), eq(telemetryAlertEpisodes.state, "firing")))
    .returning({ id: telemetryAlertEpisodes.id });
  return rows.length > 0;
}

export async function setTelemetryAlertEpisodeMessage(episodeId: string, messageTs: string): Promise<void> {
  await getDatabase()
    .update(telemetryAlertEpisodes)
    .set({ slackMessageTs: messageTs, updatedAt: new Date() })
    .where(eq(telemetryAlertEpisodes.id, episodeId));
}

export async function markTelemetryAlertRecoveryNotified(episodeId: string): Promise<void> {
  await getDatabase()
    .update(telemetryAlertEpisodes)
    .set({ recoveryNotifiedAt: new Date() })
    .where(eq(telemetryAlertEpisodes.id, episodeId));
}

export type UnannouncedTelemetryAlertRecovery = OpenTelemetryAlertEpisode & {
  endedAt: Date;
  lastValue: number;
};

// Recoveries of announced episodes whose reply has not been posted, ended
// within the last hour. Older ones are no longer worth posting.
export async function unannouncedTelemetryAlertRecoveries(alertId: string): Promise<UnannouncedTelemetryAlertRecovery[]> {
  const rows = await getDatabase()
    .select({ ...openEpisodeColumns, endedAt: telemetryAlertEpisodes.endedAt, lastValue: telemetryAlertEpisodes.lastValue })
    .from(telemetryAlertEpisodes)
    .where(
      and(
        eq(telemetryAlertEpisodes.alertId, alertId),
        eq(telemetryAlertEpisodes.state, "resolved"),
        isNull(telemetryAlertEpisodes.recoveryNotifiedAt),
        isNotNull(telemetryAlertEpisodes.slackMessageTs),
        gte(telemetryAlertEpisodes.endedAt, sql`now() - interval '1 hour'`),
      ),
    );
  return rows.map((row) => ({ ...row, endedAt: row.endedAt! }));
}

export type TelemetryAlertSlackChannel = {
  accountName: string;
  channelId: string;
  integrationAccountId: string;
  name: string;
  private: boolean;
};

// Channels an alert can post to: public channels, which the app posts to
// without joining, and private channels it is already in.
export async function listTelemetryAlertSlackChannels(organizationId: string): Promise<TelemetryAlertSlackChannel[]> {
  const rows = await getDatabase()
    .select({
      accountName: integrationAccounts.displayName,
      channelId: integrationResources.externalId,
      integrationAccountId: integrationAccounts.id,
      metadata: integrationResources.metadata,
      name: integrationResources.displayName,
    })
    .from(integrationResources)
    .innerJoin(integrationAccounts, eq(integrationAccounts.id, integrationResources.integrationAccountId))
    .where(
      and(
        eq(integrationAccounts.organizationId, organizationId),
        eq(integrationAccounts.provider, "slack"),
        eq(integrationAccounts.status, "connected"),
        eq(integrationResources.kind, "slack_channel"),
        eq(integrationResources.available, true),
      ),
    )
    .orderBy(asc(integrationAccounts.displayName), asc(integrationResources.displayName));
  return rows.flatMap(({ metadata, ...row }) => {
    const isPrivate = metadata.isPrivate === true;
    if (isPrivate && metadata.isMember !== true) return [];
    return [{ ...row, private: isPrivate }];
  });
}
