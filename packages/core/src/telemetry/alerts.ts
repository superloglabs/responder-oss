import { z } from "zod";
import { widgetFieldSource } from "./dashboards.js";

// Threshold alerts on a workspace's telemetry. Rules keep the shape Superlog
// alerts stored, so existing alerts can be copied over unchanged.

export const alertSources = ["logs", "traces", "metric"] as const;
export type AlertSource = (typeof alertSources)[number];
// Logs and spans are counted, or summed up from a field as dashboard widgets
// do; metrics are summed or averaged.
export const alertAggregations = ["count", "count_distinct", "sum", "avg", "min", "max", "p50", "p90", "p95", "p99"] as const;
export type AlertAggregation = (typeof alertAggregations)[number];
export const alertComparators = ["gt", "lt"] as const;
export type AlertComparator = (typeof alertComparators)[number];
export const alertGroupModes = ["single", "per_group"] as const;
export type AlertGroupMode = (typeof alertGroupModes)[number];

export const alertFilterSchema = z.object({
  // A metric's kind and unit, when its name is sent as more than one.
  metricKind: z.enum(["gauge", "sum", "histogram", "exponential_histogram", "summary"]).optional(),
  metricUnit: z.string().max(100).optional(),
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
  // What a log or span aggregation other than a count reads: `duration`, an
  // AI usage field such as `ai:cost`, or an attribute key.
  field: z.string().trim().max(200).nullable().default(null),
  filter: alertFilterSchema.default({}),
  groupBy: z.string().trim().max(200).nullable().default(null),
  groupMode: z.enum(alertGroupModes).default("single"),
  metricName: z.string().trim().max(200).nullable().default(null),
  source: z.enum(alertSources),
  threshold: z.number().finite(),
  windowMinutes: z.number().int().min(1).max(1_440).default(5),
});
export type AlertRule = z.infer<typeof alertRuleSchema>;

// The rule is consistent: a count of logs or spans or an aggregation of one
// of their fields, a sum or average of a named metric, and a grouping key
// when evaluated per group.
export function alertRuleProblem(rule: AlertRule): string | null {
  if (rule.source === "metric") {
    if (!rule.metricName) return "Choose a metric";
    if (rule.aggregation !== "sum" && rule.aggregation !== "avg") return "Use the sum or average of a metric";
  } else if (rule.aggregation !== "count") {
    if (!rule.field) return "Choose a field to aggregate";
    const fieldSource = widgetFieldSource(rule.field);
    if (fieldSource && fieldSource !== rule.source) {
      return fieldSource === "traces" ? "This field is on spans, not logs" : "This field is on logs, not spans";
    }
    if (rule.field.startsWith("ai:") && rule.aggregation === "count_distinct") return "Sum or average AI usage";
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

export const alertCreateSchema = refinedRule(alertRuleSchema.extend(alertSettingsSchema.shape));
export type AlertCreate = z.infer<typeof alertCreateSchema>;

// A full replacement of the rule and settings.
export const alertUpdateSchema = alertCreateSchema;
export type AlertUpdate = z.infer<typeof alertUpdateSchema>;

export const alertPreviewSchema = refinedRule(alertRuleSchema);

export function isBreaching(value: number, comparator: AlertComparator, threshold: number): boolean {
  return comparator === "gt" ? value > threshold : value < threshold;
}

export interface AlertEvaluation {
  breaching: boolean;
  // "" when the rule is evaluated as one total.
  groupKey: string;
  value: number;
}

// Whether a rule with no matching data reads zero: counts, distinct counts
// and sums of logs and spans do. Metrics, averages, extremes and percentiles
// have no value then.
export function alertCountsEmptyAsZero(rule: Pick<AlertRule, "aggregation" | "source">): boolean {
  return (
    rule.source !== "metric" &&
    (rule.aggregation === "count" || rule.aggregation === "count_distinct" || rule.aggregation === "sum")
  );
}

// One value per group, or one total. `rows` are what the store returned for
// the window: one row per group, or a single ungrouped row for a total.
// Counts, distinct counts and sums with no rows are zero; other values with
// no rows have no data and give no evaluation, so an open episode stays as
// it is.
export function evaluateAlert(
  rule: Pick<AlertRule, "aggregation" | "comparator" | "groupBy" | "groupMode" | "source" | "threshold">,
  rows: Array<{ group: string; value: number }>,
  openGroups: readonly string[],
): AlertEvaluation[] {
  const counted = alertCountsEmptyAsZero(rule);
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
  // A total is queried without grouping, so there is one row.
  if (rows.length === 0) return counted ? [evaluation("", 0)] : [];
  return [evaluation("", rows.reduce((sum, row) => sum + row.value, 0))];
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

export {
  alertFiringMessage,
  alertRecoveredMessage,
  describeAlertCondition,
  describeAlertRule,
  formatAlertValue,
  type AlertMessageInput,
} from "./alert-text.js";
