import { z } from "zod";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import {
  createTelemetryAlert,
  deleteTelemetryAlert,
  findTelemetryAlert,
  listTelemetryAlertEpisodes,
  listTelemetryAlerts,
  listTelemetryAlertSlackChannels,
  updateTelemetryAlert,
  type TelemetryAlert,
} from "../../../../packages/core/src/db/telemetry-alerts.js";
import { responderAlertUrl } from "../../../../packages/core/src/responder-urls.js";
import { alertValues } from "../../../../packages/core/src/telemetry/alert-values.js";
import {
  alertAggregations,
  alertComparators,
  alertCreateSchema,
  alertFilterSchema,
  alertGroupModes,
  alertPreviewSchema,
  alertSources,
  evaluateAlert,
  rankAlertEvaluations,
  type AlertSlackTarget,
} from "../../../../packages/core/src/telemetry/alerts.js";
import { getTelemetryClient, type TelemetryClient } from "../../../../packages/core/src/telemetry/client.js";
import { controlPlaneBaseUrl } from "../integrations/urls.js";
import { defineOperation, ManagementError, type ManagementContext } from "./operation.js";

// Threshold alerts on the workspace's telemetry, as the Alerts page shows
// them. They need the telemetry and alerts features and a telemetry store.

const alertId = z.uuid().describe("Alert ID.");

const ruleFields = {
  aggregation: z
    .enum(alertAggregations)
    .describe("`count` counts matching logs or spans; other aggregations read `field`. Metrics use `sum` or `avg`."),
  comparator: z.enum(alertComparators).describe("`gt` fires when the value is above `threshold`, `lt` when it is below."),
  field: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .describe("What a log or span aggregation other than `count` reads: `duration`, an attribute key, or an AI usage field such as `ai:cost`."),
  filter: alertFilterSchema.describe(
    "Narrows the data the alert reads. `resourceAttrs` keys may start with `resource.`, `span.`, `log.`, or `field.`; a bare key is a resource attribute. `service`, `severity`, `spanName`, `statusCode`, and `minDurationMs` match those fields of a log or span.",
  ),
  groupBy: z.string().trim().max(200).nullable().describe("The attribute key to split by when `groupMode` is `per_group`, such as `service.name`."),
  groupMode: z
    .enum(alertGroupModes)
    .describe("`single` checks one total. `per_group` checks each `groupBy` value and fires for each one separately."),
  metricName: z.string().trim().max(200).nullable().describe("The metric to read when `source` is `metric`."),
  source: z.enum(alertSources).describe("`logs`, `traces` (spans), or `metric`."),
  threshold: z.number().finite(),
  windowMinutes: z.number().int().min(1).max(1_440).describe("How many minutes of data each check reads."),
};

const settingFields = {
  enabled: z.boolean().describe("A disabled alert is not checked."),
  evaluationIntervalSeconds: z.number().int().min(60).max(3_600).describe("How often the alert is checked."),
  name: z.string().trim().min(1).max(200),
  slack: z
    .object({
      channelId: z.string().trim().min(1).max(64).describe("The Slack channel ID: the `externalId` of a `slack_channel` resource."),
      integrationAccountId: z.uuid().describe("The ID of the Slack integration the channel belongs to."),
    })
    .nullable()
    .describe("Where firing and recovery messages are posted. Without a channel the alert only records its activations."),
};

const optionalRuleFields = {
  field: ruleFields.field.optional(),
  filter: ruleFields.filter.optional(),
  groupBy: ruleFields.groupBy.optional(),
  groupMode: ruleFields.groupMode.optional().describe(`${ruleFields.groupMode.description} Defaults to \`single\`.`),
  metricName: ruleFields.metricName.optional(),
  windowMinutes: ruleFields.windowMinutes.optional().describe(`${ruleFields.windowMinutes.description} Defaults to 5.`),
};

const alertSchema = z.object({
  ...ruleFields,
  createdAt: z.string(),
  enabled: z.boolean(),
  evaluationIntervalSeconds: z.number().int(),
  id: alertId,
  lastError: z.string().nullable().describe("Why the last check failed, if it did."),
  lastEvaluatedAt: z.string().nullable(),
  name: z.string(),
  slack: z.object({ channelId: z.string(), integrationAccountId: z.string() }).nullable(),
  updatedAt: z.string(),
  url: z.url().describe("The alert in Superlog."),
});

const activationSchema = z.object({
  endedAt: z.string().nullable(),
  endReason: z
    .enum(["recovered", "configuration_changed"])
    .nullable()
    .optional()
    .describe("`configuration_changed` when the rule changed or was disabled while it fired."),
  groupKey: z.string().describe("The `groupBy` value, or empty for a single total."),
  id: z.string(),
  lastValue: z.number(),
  openValue: z.number(),
  peakValue: z.number(),
  startedAt: z.string(),
  state: z.enum(["firing", "resolved"]),
});

const recentActivations = 20;

function withUrl<Alert extends TelemetryAlert>(alert: Alert): Alert & { url: string } {
  return { ...alert, url: responderAlertUrl(alert.id, controlPlaneBaseUrl()) };
}

const alertNotFound = () => new ManagementError(404, "Alert not found", "alert_not_found");

async function requireAlerts(context: ManagementContext): Promise<TelemetryClient> {
  const [telemetry, alerts] = await Promise.all([
    organizationHasCapability(context.organizationId, "telemetry"),
    organizationHasCapability(context.organizationId, "alerts"),
  ]);
  const client = getTelemetryClient();
  if (!client || !telemetry || !alerts) {
    throw new ManagementError(404, "Alerts are not available in this workspace.", "alerts_unavailable");
  }
  return client;
}

// Checks a whole alert with the rules the Alerts page applies.
function parseAlert<Schema extends z.ZodType>(schema: Schema, input: unknown): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ManagementError(400, "Invalid alert", "invalid_request", parsed.error.issues);
  return parsed.data;
}

// The channel must belong to one of the workspace's connected Slack
// workspaces, and the app must be in it when it is private.
async function checkSlack(context: ManagementContext, slack: AlertSlackTarget | null): Promise<void> {
  if (!slack) return;
  const channels = await listTelemetryAlertSlackChannels(context.organizationId);
  const found = channels.some(
    (channel) => channel.channelId === slack.channelId && channel.integrationAccountId === slack.integrationAccountId,
  );
  if (!found) {
    throw new ManagementError(
      400,
      "Choose a Slack channel from a connected workspace. For a private channel, invite the Superlog app first.",
      "slack_channel_unavailable",
    );
  }
}

export const alertOperations = [
  defineOperation({
    name: "list_alerts",
    summary: "List alerts",
    description: "Lists the workspace's alerts by name, with each one's rule, Slack channel, and how many groups are firing now.",
    method: "GET",
    path: "/alerts",
    tag: "Alerts",
    effect: "read",
    input: z.object({}),
    output: z.object({
      alerts: z.array(alertSchema.extend({ firingGroups: z.number().int().describe("Activations open now.") })),
    }),
    async run(context) {
      await requireAlerts(context);
      return { alerts: (await listTelemetryAlerts(context.organizationId)).map(withUrl) };
    },
  }),
  defineOperation({
    name: "get_alert",
    summary: "Get an alert",
    description: `Returns an alert with its ${recentActivations} most recent activations. An activation is one period during which the alert, or one of its groups, was past the threshold.`,
    method: "GET",
    path: "/alerts/{alertId}",
    tag: "Alerts",
    effect: "read",
    input: z.object({ alertId }),
    output: z.object({ activations: z.array(activationSchema), alert: alertSchema }),
    async run(context, input) {
      await requireAlerts(context);
      const alert = await findTelemetryAlert(context.organizationId, input.alertId);
      if (!alert) throw alertNotFound();
      return { activations: await listTelemetryAlertEpisodes(alert.id, recentActivations), alert: withUrl(alert) };
    },
  }),
  defineOperation({
    name: "create_alert",
    summary: "Create an alert",
    description:
      "Creates a threshold alert on logs, spans, or a metric. While the value is past the threshold, the alert posts once to its Slack channel and posts the recovery in the same thread.",
    method: "POST",
    path: "/alerts",
    tag: "Alerts",
    effect: "write",
    successStatus: 201,
    input: z.object({
      ...ruleFields,
      ...optionalRuleFields,
      enabled: settingFields.enabled.optional().describe(`${settingFields.enabled.description} Defaults to true.`),
      evaluationIntervalSeconds: settingFields.evaluationIntervalSeconds
        .optional()
        .describe(`${settingFields.evaluationIntervalSeconds.description} Defaults to 60.`),
      name: settingFields.name,
      slack: settingFields.slack.optional(),
    }),
    output: z.object({ alert: alertSchema }),
    async run(context, input) {
      await requireAlerts(context);
      const alert = parseAlert(alertCreateSchema, input);
      await checkSlack(context, alert.slack);
      const created = await createTelemetryAlert(context.organizationId, { ...alert, createdBy: context.user.id });
      return { alert: withUrl(created) };
    },
  }),
  defineOperation({
    name: "update_alert",
    summary: "Change an alert",
    description:
      "Changes the fields you send and keeps the rest. `filter` replaces the whole filter. Changing what the alert reads or its threshold, or disabling it, ends its open activations without posting a recovery; the next check opens new ones where the value is still past the threshold.",
    method: "PATCH",
    path: "/alerts/{alertId}",
    tag: "Alerts",
    effect: "destructive",
    input: z.object({ ...ruleFields, ...settingFields }).partial().extend({ alertId }),
    output: z.object({ alert: alertSchema }),
    async run(context, input) {
      await requireAlerts(context);
      const { alertId: id, ...changes } = input;
      if (Object.values(changes).every((value) => value === undefined)) {
        throw new ManagementError(400, "Send at least one field to change.", "nothing_to_update");
      }
      const current = await findTelemetryAlert(context.organizationId, id);
      if (!current) throw alertNotFound();
      const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
      const alert = parseAlert(alertCreateSchema, { ...current, ...defined });
      await checkSlack(context, alert.slack);
      const updated = await updateTelemetryAlert(context.organizationId, id, alert);
      if (!updated) throw alertNotFound();
      return { alert: withUrl(updated) };
    },
  }),
  defineOperation({
    name: "delete_alert",
    summary: "Delete an alert",
    description: "Deletes an alert and its activation history.",
    method: "DELETE",
    path: "/alerts/{alertId}",
    tag: "Alerts",
    effect: "destructive",
    input: z.object({ alertId }),
    output: z.object({ deleted: z.literal(true) }),
    async run(context, input) {
      await requireAlerts(context);
      if (!(await deleteTelemetryAlert(context.organizationId, input.alertId))) throw alertNotFound();
      return { deleted: true as const };
    },
  }),
  defineOperation({
    name: "list_slack_channels",
    summary: "List Slack channels for alerts",
    description:
      "Lists the Slack channels alerts and synthetic checks can post to: public channels, and private channels the Superlog app is in.",
    method: "GET",
    path: "/slack-channels",
    tag: "Integrations",
    effect: "read",
    input: z.object({}),
    output: z.object({
      channels: z.array(
        z.object({
          accountName: z.string().describe("The Slack workspace's name."),
          channelId: z.string().describe("The `channelId` to use in an alert's or check's `slack`."),
          integrationAccountId: z.string().describe("The `integrationAccountId` to use in an alert's or check's `slack`."),
          name: z.string().describe("The channel name, without `#`."),
          private: z.boolean(),
        }),
      ),
    }),
    async run(context) {
      if (!(await organizationHasCapability(context.organizationId, "alerts"))) {
        throw new ManagementError(404, "Alerts are not available in this workspace.", "alerts_unavailable");
      }
      return { channels: await listTelemetryAlertSlackChannels(context.organizationId) };
    },
  }),
  defineOperation({
    name: "preview_alert",
    summary: "Preview an alert rule",
    description:
      "Reads the current window of a draft rule without saving it, and returns each group's value and whether it is past the threshold, those past it first. Use it to choose a threshold.",
    method: "POST",
    path: "/alerts/preview",
    tag: "Alerts",
    effect: "read",
    input: z.object({ ...ruleFields, ...optionalRuleFields }),
    output: z.object({
      evaluations: z
        .array(z.object({ breaching: z.boolean(), groupKey: z.string(), value: z.number() }))
        .describe("At most 50 groups. Empty when a rule other than a count, distinct count, or sum has no data in the window."),
    }),
    async run(context, input) {
      const client = await requireAlerts(context);
      const rule = parseAlert(alertPreviewSchema, input);
      const values = await alertValues(client, context.organizationId, rule, new Date());
      return { evaluations: rankAlertEvaluations(rule, evaluateAlert(rule, values, [])).slice(0, 50) };
    },
  }),
];
