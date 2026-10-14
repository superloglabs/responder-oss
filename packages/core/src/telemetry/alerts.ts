import { z } from "zod";

// Threshold alerts on a telemetry project. Rules keep the shape Superlog
// alerts stored, so existing alerts can be copied over unchanged.

export const alertSources = ["logs", "traces", "metric"] as const;
export type AlertSource = (typeof alertSources)[number];
export const alertAggregations = ["count", "sum", "avg"] as const;
export type AlertAggregation = (typeof alertAggregations)[number];
export const alertComparators = ["gt", "lt"] as const;
export type AlertComparator = (typeof alertComparators)[number];
export const alertGroupModes = ["single", "per_group"] as const;
export type AlertGroupMode = (typeof alertGroupModes)[number];

export const alertFilterSchema = z.object({
  minDurationMs: z.number().nonnegative().max(3_600_000).optional(),
  // Keys may be prefixed with resource., span., log. or field.; a bare key is
  // a resource attribute.
  resourceAttrs: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(200),
        op: z.enum(["eq", "neq", "not_contains"]).optional(),
        value: z.string().max(500),
      }),
    )
    .max(50)
    .optional(),
  service: z.string().trim().max(200).optional(),
  severity: z.string().trim().max(50).optional(),
  spanName: z.string().trim().max(200).optional(),
  statusCode: z.string().trim().max(50).optional(),
});
export type AlertFilter = z.infer<typeof alertFilterSchema>;

const alertSlackSchema = z.object({
  channelId: z.string().trim().min(1).max(64),
  integrationAccountId: z.uuid(),
});
export type AlertSlackTarget = z.infer<typeof alertSlackSchema>;

// Fields an alert rule is evaluated with.
export const alertRuleSchema = z.object({
  aggregation: z.enum(alertAggregations),
  comparator: z.enum(alertComparators),
  filter: alertFilterSchema.default({}),
  groupBy: z.string().trim().max(200).nullable().default(null),
  groupMode: z.enum(alertGroupModes).default("single"),
  metricName: z.string().trim().max(200).nullable().default(null),
  source: z.enum(alertSources),
  threshold: z.number().finite(),
  windowMinutes: z.number().int().min(1).max(1_440).default(5),
});
export type AlertRule = z.infer<typeof alertRuleSchema>;

// The rule is consistent: counts for logs and traces, a sum or average of a
// named metric, and a grouping key when evaluated per group.
export function alertRuleProblem(rule: AlertRule): string | null {
  if (rule.source === "metric") {
    if (!rule.metricName) return "Choose a metric";
    if (rule.aggregation === "count") return "Use the sum or average of a metric";
  } else if (rule.aggregation !== "count") {
    return "Logs and traces are counted";
  }
  if (rule.groupMode === "per_group" && !rule.groupBy) return "Choose what to group by";
  return null;
}

const refinedRule = <T extends z.ZodType<AlertRule>>(schema: T) =>
  schema.superRefine((rule, context) => {
    const problem = alertRuleProblem(rule);
    if (problem) context.addIssue({ code: "custom", message: problem });
  });

const alertSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  // How often the rule is checked. Superlog allowed 15 seconds; checks here
  // share a read-only store, so one minute is the shortest.
  evaluationIntervalSeconds: z.number().int().min(60).max(3_600).default(60),
  name: z.string().trim().min(1).max(200),
  slack: alertSlackSchema.nullable().default(null),
});

export const alertCreateSchema = refinedRule(
  alertRuleSchema.extend(alertSettingsSchema.shape).extend({ projectId: z.uuid() }),
);
export type AlertCreate = z.infer<typeof alertCreateSchema>;

// A full replacement of the rule and settings.
export const alertUpdateSchema = refinedRule(alertRuleSchema.extend(alertSettingsSchema.shape));
export type AlertUpdate = z.infer<typeof alertUpdateSchema>;

export const alertPreviewSchema = refinedRule(alertRuleSchema.extend({ projectId: z.uuid() }));

export function isBreaching(value: number, comparator: AlertComparator, threshold: number): boolean {
  return comparator === "gt" ? value > threshold : value < threshold;
}

export interface AlertEvaluation {
  breaching: boolean;
  // "" when the rule is evaluated as one total.
  groupKey: string;
  value: number;
}

// One value per group, or one total. `rows` are what the store returned for
// the window. Counts with no rows are zero; metrics with no rows have no
// data and give no evaluation, so an open episode stays as it is.
export function evaluateAlert(
  rule: Pick<AlertRule, "aggregation" | "comparator" | "groupBy" | "groupMode" | "source" | "threshold">,
  rows: Array<{ group: string; value: number }>,
  openGroups: readonly string[],
): AlertEvaluation[] {
  const counted = rule.source !== "metric";
  const evaluation = (groupKey: string, value: number) => ({
    breaching: isBreaching(value, rule.comparator, rule.threshold),
    groupKey,
    value,
  });
  if (rule.groupMode === "per_group" && rule.groupBy) {
    const values = new Map(rows.map((row) => [row.group, row.value]));
    // A group that stopped reporting counts as zero, so its episode can end.
    if (counted) for (const group of openGroups) if (!values.has(group)) values.set(group, 0);
    return [...values].map(([group, value]) => evaluation(group, value));
  }
  if (rows.length === 0) return counted ? [evaluation("", 0)] : [];
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return [evaluation("", rule.aggregation === "avg" ? total / rows.length : total)];
}

export type AlertTransition = "opened" | "continued" | "recovered";

// What a group's evaluation does to its episode.
export function alertTransition(breaching: boolean, open: boolean): AlertTransition | null {
  if (breaching) return open ? "continued" : "opened";
  return open ? "recovered" : null;
}

// The value furthest past the threshold.
export function worseValue(comparator: AlertComparator, a: number, b: number): number {
  return comparator === "gt" ? Math.max(a, b) : Math.min(a, b);
}

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function formatAlertValue(value: number): string {
  return numberFormat.format(value);
}

function windowLabel(minutes: number): string {
  if (minutes % 1_440 === 0) return minutes === 1_440 ? "day" : `${minutes / 1_440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "hour" : `${minutes / 60} hours`;
  return minutes === 1 ? "minute" : `${minutes} minutes`;
}

// "Error logs from checkout in the last 5 minutes", for messages and lists.
export function describeAlertRule(rule: Pick<AlertRule, "aggregation" | "filter" | "metricName" | "source" | "windowMinutes">): string {
  const measured =
    rule.source === "metric"
      ? `${rule.aggregation === "avg" ? "Average" : "Sum"} of ${rule.metricName ?? "a metric"}`
      : rule.source === "traces"
        ? rule.filter.statusCode === "STATUS_CODE_ERROR" ? "Error spans" : "Spans"
        : rule.filter.severity ? `${rule.filter.severity.toUpperCase()} logs` : "Logs";
  const service = rule.filter.service ? ` from ${rule.filter.service}` : "";
  return `${measured}${service} in the last ${windowLabel(rule.windowMinutes)}`;
}

export function describeAlertCondition(comparator: AlertComparator, threshold: number): string {
  return `${comparator === "gt" ? "above" : "below"} ${formatAlertValue(threshold)}`;
}

export interface AlertMessageInput {
  alertName: string;
  alertUrl: string | null;
  groupBy: string | null;
  groupKey: string;
  rule: Pick<AlertRule, "aggregation" | "comparator" | "filter" | "metricName" | "source" | "threshold" | "windowMinutes">;
  value: number;
}

function groupLabel(input: Pick<AlertMessageInput, "groupBy" | "groupKey">): string {
  if (!input.groupBy) return "";
  return ` for ${input.groupBy.replace(/^attr:/u, "")} \`${input.groupKey || "(none)"}\``;
}

// The message posted when an episode opens.
export function alertFiringMessage(input: AlertMessageInput): { markdown: string; text: string } {
  const group = groupLabel(input);
  const link = input.alertUrl ? `\n\n[View alert](${input.alertUrl})` : "";
  return {
    markdown:
      `:rotating_light: **${input.alertName}** is firing${group}.\n\n` +
      `${describeAlertRule(input.rule)}: **${formatAlertValue(input.value)}**, ` +
      `${describeAlertCondition(input.rule.comparator, input.rule.threshold)}.${link}`,
    text: `${input.alertName} is firing${group.replaceAll("`", "")}`,
  };
}

function durationLabel(milliseconds: number): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"}${rest ? ` ${rest} minute${rest === 1 ? "" : "s"}` : ""}`;
}

// The thread reply posted when an episode ends.
export function alertRecoveredMessage(
  input: AlertMessageInput & { firingForMs: number },
): { markdown: string; text: string } {
  const group = groupLabel(input);
  const back = input.rule.comparator === "gt" ? "at or below" : "at or above";
  return {
    markdown:
      `:white_check_mark: **${input.alertName}** recovered${group} after ${durationLabel(input.firingForMs)}. ` +
      `The value is **${formatAlertValue(input.value)}**, ${back} ${formatAlertValue(input.rule.threshold)}.`,
    text: `${input.alertName} recovered${group.replaceAll("`", "")}`,
  };
}
