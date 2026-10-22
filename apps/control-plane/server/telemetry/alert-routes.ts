import { Hono } from "hono";
import { z } from "zod";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import {
  createTelemetryAlert,
  deleteTelemetryAlert,
  findTelemetryAlert,
  findTelemetryAlertActivation,
  listTelemetryAlertEpisodes,
  listTelemetryAlerts,
  listTelemetryAlertSlackChannels,
  updateTelemetryAlert,
} from "../../../../packages/core/src/db/telemetry-alerts.js";
import { refreshSlackChannelResources } from "../../../../packages/core/src/integrations/slack-channels.js";
import { alertMetricIdentity, alertValues, alertWindow } from "../../../../packages/core/src/telemetry/alert-values.js";
import {
  alertCreateSchema,
  alertPreviewSchema,
  alertUpdateSchema,
  alertCountsEmptyAsZero,
  evaluateAlert,
  type AlertRule,
  type AlertSlackTarget,
} from "../../../../packages/core/src/telemetry/alerts.js";
import { getTelemetryClient, type TelemetryClient } from "../../../../packages/core/src/telemetry/client.js";
import { chartSeries } from "../../../../packages/core/src/telemetry/dashboards.js";
import { aiPriceParamsFor } from "../../../../packages/core/src/telemetry/ai-price-params.js";
import { countSeries, eventSeries, metricSeries } from "../../../../packages/core/src/telemetry/query.js";
import { getActiveTenant } from "../tenant.js";

// Threshold alerts on a workspace's telemetry. They need the
// telemetry and alerts capabilities and a configured telemetry store.
export type AlertRouteDependencies = {
  client: () => TelemetryClient | null;
  createAlert: typeof createTelemetryAlert;
  deleteAlert: typeof deleteTelemetryAlert;
  episodes: typeof listTelemetryAlertEpisodes;
  findAlert: typeof findTelemetryAlert;
  findActivation: typeof findTelemetryAlertActivation;
  hasCapability: (organizationId: string, capability: "alerts" | "telemetry") => Promise<boolean>;
  listAlerts: typeof listTelemetryAlerts;
  now: () => Date;
  // The rule's value per bucket over recent windows, for its chart.
  series: (
    client: TelemetryClient,
    organizationId: string,
    rule: AlertRule,
    now: Date,
    range?: { since: string; until: string },
  ) => Promise<Array<{ bucket: string; group: string; value: number }>>;
  refreshSlackChannels: (organizationId: string) => Promise<void>;
  slackChannels: typeof listTelemetryAlertSlackChannels;
  tenant: (
    headers: Headers,
  ) => Promise<
    | { ok: true; organizationId: string; user: { id: string } }
    | { error: string; ok: false; status: 401 | 403 | 409 }
  >;
  updateAlert: typeof updateTelemetryAlert;
  values: typeof alertValues;
};

// The chart covers this many windows of the rule.
const chartWindows = 24;

function windowStep(windowMinutes: number) {
  return windowMinutes % 1_440 === 0
    ? { n: windowMinutes / 1_440, unit: "DAY" as const }
    : windowMinutes % 60 === 0
      ? { n: windowMinutes / 60, unit: "HOUR" as const }
      : { n: windowMinutes, unit: "MINUTE" as const };
}

async function defaultSeries(client: TelemetryClient, organizationId: string, rule: AlertRule, now: Date, requestedRange?: { since: string; until: string }) {
  const range = requestedRange ?? alertWindow(rule.windowMinutes * chartWindows, now);
  const groupBy = rule.groupMode === "per_group" && rule.groupBy ? rule.groupBy : undefined;
  const step = windowStep(rule.windowMinutes);
  if (rule.source === "metric") {
    return metricSeries(
      client,
      organizationId,
      rule.metricName!,
      { range, resourceAttrs: rule.filter.resourceAttrs ?? [], ...(rule.filter.service ? { service: rule.filter.service } : {}) },
      groupBy,
      step,
      rule.aggregation === "avg" ? "avg" : "sum",
      alertMetricIdentity(rule.filter),
    );
  }
  if (rule.aggregation !== "count" && rule.field) {
    const filter = { ...rule.filter, range, resourceAttrs: rule.filter.resourceAttrs ?? [] };
    const aiPrices = rule.field === "ai:cost" ? await aiPriceParamsFor(client, organizationId, filter) : undefined;
    return eventSeries(
      client,
      organizationId,
      rule.source,
      filter,
      { aggregation: rule.aggregation, field: rule.field },
      groupBy,
      step,
      aiPrices,
    );
  }
  const rows = await countSeries(
    client,
    organizationId,
    rule.source,
    { ...rule.filter, range, resourceAttrs: rule.filter.resourceAttrs ?? [] },
    groupBy,
    step,
  );
  return rows.map((row) => ({ bucket: row.bucket, group: row.group, value: row.count }));
}

const defaultDependencies: AlertRouteDependencies = {
  client: getTelemetryClient,
  createAlert: createTelemetryAlert,
  deleteAlert: deleteTelemetryAlert,
  episodes: listTelemetryAlertEpisodes,
  findAlert: findTelemetryAlert,
  findActivation: findTelemetryAlertActivation,
  hasCapability: organizationHasCapability,
  listAlerts: listTelemetryAlerts,
  now: () => new Date(),
  refreshSlackChannels: (organizationId) => refreshSlackChannelResources(organizationId),
  series: defaultSeries,
  slackChannels: listTelemetryAlertSlackChannels,
  tenant: getActiveTenant,
  updateAlert: updateTelemetryAlert,
  values: alertValues,
};

const idSchema = z.uuid();

async function jsonBody(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
}

export function createAlertRoutes(dependencies: AlertRouteDependencies = defaultDependencies) {
  async function access(headers: Headers): Promise<
    | { client: TelemetryClient; ok: true; organizationId: string; userId: string }
    | { error: string; ok: false; status: 401 | 403 | 404 | 409 }
  > {
    const tenant = await dependencies.tenant(headers);
    if (tenant.ok === false) return { error: tenant.error, ok: false, status: tenant.status };
    const client = dependencies.client();
    const [telemetry, alerts] = await Promise.all([
      dependencies.hasCapability(tenant.organizationId, "telemetry"),
      dependencies.hasCapability(tenant.organizationId, "alerts"),
    ]);
    if (!client || !telemetry || !alerts) return { error: "Alerts are not available", ok: false, status: 404 };
    return { client, ok: true, organizationId: tenant.organizationId, userId: tenant.user.id };
  }

  // A channel the workspace can post alerts to, or null when there is none.
  async function slackProblem(organizationId: string, slack: AlertSlackTarget | null): Promise<string | null> {
    if (!slack) return null;
    const channels = await dependencies.slackChannels(organizationId);
    const found = channels.some(
      (channel) => channel.channelId === slack.channelId && channel.integrationAccountId === slack.integrationAccountId,
    );
    return found ? null : "Choose a Slack channel from a connected workspace";
  }

  const notFound = { error: "Alert not found" };

  return new Hono()
    .get("/", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      return context.json({ alerts: await dependencies.listAlerts(granted.organizationId) });
    })
    .post("/", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const body = alertCreateSchema.safeParse(await jsonBody(context.req.raw));
      if (!body.success) return context.json({ error: body.error.issues[0]?.message ?? "Invalid alert" }, 400);
      const problem = await slackProblem(granted.organizationId, body.data.slack);
      if (problem) return context.json({ error: problem }, 400);
      const alert = await dependencies.createAlert(granted.organizationId, { ...body.data, createdBy: granted.userId });
      return context.json({ alert }, 201);
    })
    .get("/slack-channels", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      return context.json({ channels: await dependencies.slackChannels(granted.organizationId) });
    })
    .post("/slack-channels/refresh", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      await dependencies.refreshSlackChannels(granted.organizationId);
      return context.json({ channels: await dependencies.slackChannels(granted.organizationId) });
    })
    // The rule's current value per group, and its recent values for a chart.
    .post("/preview", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const body = alertPreviewSchema.safeParse(await jsonBody(context.req.raw));
      if (!body.success) return context.json({ error: body.error.issues[0]?.message ?? "Invalid alert" }, 400);
      const rule = body.data;
      const now = dependencies.now();
      const hours = context.req.query("hours");
      if (hours && !["1", "6", "24"].includes(hours)) return context.json({ error: "Invalid chart range" }, 400);
      const range = alertWindow(hours ? Number(hours) * 60 : rule.windowMinutes * chartWindows, now);
      const [values, series] = await Promise.all([
        dependencies.values(granted.client, granted.organizationId, rule, now),
        dependencies.series(granted.client, granted.organizationId, rule, now, range),
      ]);
      // Breaching groups first, then furthest past the threshold.
      const severity = rule.comparator === "gt" ? 1 : -1;
      const evaluations = evaluateAlert(rule, values, [])
        .sort((a, b) => Number(b.breaching) - Number(a.breaching) || severity * (b.value - a.value))
        .slice(0, 50);
      // Buckets are one window long.
      const stepMs = rule.windowMinutes * 60_000;
      return context.json({
        chart: chartSeries(series, {
          fill: alertCountsEmptyAsZero(rule) ? "zero" : "null",
          limit: 5,
          sinceMs: Date.parse(range.since),
          stepMs,
          untilMs: Date.parse(range.until),
        }),
        evaluations,
      });
    })
    .get("/:alertId", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const alertId = idSchema.safeParse(context.req.param("alertId"));
      if (!alertId.success) return context.json(notFound, 404);
      const alert = await dependencies.findAlert(granted.organizationId, alertId.data);
      if (!alert) return context.json(notFound, 404);
      return context.json({ alert, episodes: await dependencies.episodes(alert.id) });
    })
    .get("/:alertId/activations", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const alertId = idSchema.safeParse(context.req.param("alertId"));
      if (!alertId.success) return context.json(notFound, 404);
      const query = z.object({
        days: z.enum(["7", "30", "all"]).default("7"),
        state: z.enum(["all", "firing", "resolved"]).default("all"),
        offset: z.coerce.number().int().min(0).max(10000).default(0),
      }).safeParse(context.req.query());
      if (!query.success) return context.json({ error: "Invalid history filters" }, 400);
      const alert = await dependencies.findAlert(granted.organizationId, alertId.data);
      if (!alert) return context.json(notFound, 404);
      const { days, state, offset } = query.data;
      const episodes = await dependencies.episodes(alert.id, 51, {
        offset, ...(days !== "all" ? { since: new Date(dependencies.now().getTime() - Number(days) * 86_400_000) } : {}),
        ...(state !== "all" ? { state } : {}),
      });
      return context.json({ episodes: episodes.slice(0, 50), hasMore: episodes.length > 50 });
    })
    .get("/:alertId/activations/:activationId", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const alertId = idSchema.safeParse(context.req.param("alertId"));
      const activationId = idSchema.safeParse(context.req.param("activationId"));
      if (!alertId.success || !activationId.success) return context.json(notFound, 404);
      const alert = await dependencies.findAlert(granted.organizationId, alertId.data);
      if (!alert) return context.json(notFound, 404);
      const activation = await dependencies.findActivation(alert.id, activationId.data);
      if (!activation) return context.json({ error: "Activation not found" }, 404);
      return context.json({ alert, activation });
    })
    .get("/:alertId/activations/:activationId/chart", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const alertId = idSchema.safeParse(context.req.param("alertId"));
      const activationId = idSchema.safeParse(context.req.param("activationId"));
      if (!alertId.success || !activationId.success) return context.json(notFound, 404);
      const alert = await dependencies.findAlert(granted.organizationId, alertId.data);
      if (!alert) return context.json(notFound, 404);
      const activation = await dependencies.findActivation(alert.id, activationId.data);
      if (!activation) return context.json({ error: "Activation not found" }, 404);
      const rule = activation.ruleSnapshot;
      if (!rule) return context.json({ chart: null, reason: "The original rule was not recorded for this activation." });
      const now = dependencies.now();
      const padding = rule.windowMinutes * 60_000 * 3;
      const start = Date.parse(activation.startedAt);
      const end = Math.min(Date.parse(activation.endedAt ?? now.toISOString()) + padding, now.getTime(), start + 7 * 86_400_000);
      const range = { since: new Date(start - padding).toISOString(), until: new Date(end).toISOString() };
      const series = await dependencies.series(granted.client, granted.organizationId, rule, new Date(end), range);
      return context.json({ chart: chartSeries(
        rule.groupMode === "per_group" ? series.filter((row) => row.group === activation.groupKey) : series,
        { fill: alertCountsEmptyAsZero(rule) ? "zero" : "null", limit: 5,
          sinceMs: Date.parse(range.since), untilMs: end, stepMs: rule.windowMinutes * 60_000 },
      ), reason: null });
    })
    .put("/:alertId", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const alertId = idSchema.safeParse(context.req.param("alertId"));
      if (!alertId.success) return context.json(notFound, 404);
      const body = alertUpdateSchema.safeParse(await jsonBody(context.req.raw));
      if (!body.success) return context.json({ error: body.error.issues[0]?.message ?? "Invalid alert" }, 400);
      const problem = await slackProblem(granted.organizationId, body.data.slack);
      if (problem) return context.json({ error: problem }, 400);
      const alert = await dependencies.updateAlert(granted.organizationId, alertId.data, body.data);
      return alert ? context.json({ alert }) : context.json(notFound, 404);
    })
    .delete("/:alertId", async (context) => {
      const granted = await access(context.req.raw.headers);
      if (!granted.ok) return context.json({ error: granted.error }, granted.status);
      const alertId = idSchema.safeParse(context.req.param("alertId"));
      if (!alertId.success) return context.json(notFound, 404);
      return (await dependencies.deleteAlert(granted.organizationId, alertId.data))
        ? context.body(null, 204)
        : context.json(notFound, 404);
    });
}
