import type { AlertComparator, AlertRule } from "./alerts.js";

// How alerts read in Slack and the app. Kept apart from the rule schemas so
// the app can use it without the validation library.

// Text from users or telemetry, made inert in Slack: no mentions, links or
// formatting. Backslashes are escaped first, so they cannot undo the other
// escapes. A zero-width space after each "." and ":" stops Slack from
// turning URLs and domains into links.
export function slackText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_~[\]|#]/gu, (character) => `\\${character}`)
    .replace(/[.:]/gu, (character) => `${character}\u200b`);
}

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const dollars = new Intl.NumberFormat("en-US", { currency: "USD", maximumFractionDigits: 2, minimumFractionDigits: 2, style: "currency" });
const centDollars = new Intl.NumberFormat("en-US", { currency: "USD", maximumSignificantDigits: 2, style: "currency" });

// The unit a rule's value is in: dollars for AI cost, milliseconds for span
// duration, and none for counts and other fields.
export type AlertValueUnit = "ms" | "none" | "usd";

export function alertValueUnit(rule: Pick<AlertRule, "aggregation" | "field" | "source">): AlertValueUnit {
  if (rule.source === "metric" || rule.aggregation === "count" || rule.aggregation === "count_distinct") return "none";
  if (rule.field === "ai:cost") return "usd";
  if (rule.field === "duration") return "ms";
  return "none";
}

export function formatAlertValue(value: number, unit: AlertValueUnit = "none"): string {
  if (unit === "usd") {
    const size = Math.abs(value);
    // Fractions of a cent keep two significant digits, so a call's cost shows.
    return size > 0 && size < 0.01 ? centDollars.format(value) : dollars.format(value);
  }
  return unit === "ms" ? `${numberFormat.format(value)} ms` : numberFormat.format(value);
}

const aggregationLabels: Record<AlertRule["aggregation"], string> = {
  avg: "Average",
  count: "Count",
  count_distinct: "Distinct values",
  max: "Maximum",
  min: "Minimum",
  p50: "Median",
  p90: "90th percentile",
  p95: "95th percentile",
  p99: "99th percentile",
  sum: "Sum",
};

const aiFieldLabels: Record<string, string> = {
  "ai:cost": "AI cost",
  "ai:model": "AI model",
  "ai:provider": "AI provider",
  "ai:tokens.cache_read": "AI cache read tokens",
  "ai:tokens.cache_write": "AI cache write tokens",
  "ai:tokens.input": "AI input tokens",
  "ai:tokens.input_uncached": "AI uncached input tokens",
  "ai:tokens.output": "AI output tokens",
  "ai:tokens.reasoning": "AI reasoning tokens",
  "ai:tokens.total": "AI tokens",
};

// A field as people read it: span duration, an AI usage field, or an
// attribute key without its scope prefix.
export function alertFieldLabel(field: string): string {
  if (field === "duration") return "span duration";
  return aiFieldLabels[field] ?? field.replace(/^(?:attr:|resource\.|span\.|log\.)/u, "");
}

function windowLabel(minutes: number): string {
  if (minutes % 1_440 === 0) return minutes === 1_440 ? "day" : `${minutes / 1_440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "hour" : `${minutes / 60} hours`;
  return minutes === 1 ? "minute" : `${minutes} minutes`;
}

// "Error logs from checkout in the last 5 minutes" or "Sum of AI cost in the
// last hour", for messages and lists.
export function describeAlertRule(
  rule: Pick<AlertRule, "aggregation" | "field" | "filter" | "metricName" | "source" | "windowMinutes">,
): string {
  const counted =
    rule.source === "traces"
      ? rule.filter.statusCode === "STATUS_CODE_ERROR" ? "error spans" : "spans"
      : rule.filter.severity ? `${rule.filter.severity.toUpperCase()} logs` : "logs";
  const measured =
    rule.source === "metric"
      ? `${rule.aggregation === "avg" ? "Average" : "Sum"} of ${rule.metricName ?? "a metric"}`
      : rule.aggregation !== "count" && rule.field
        ? `${aggregationLabels[rule.aggregation]} of ${alertFieldLabel(rule.field)}${
            rule.field.startsWith("ai:") && rule.filter.statusCode !== "STATUS_CODE_ERROR" ? "" : ` over ${counted}`
          }`
        : counted.charAt(0).toUpperCase() + counted.slice(1);
  const service = rule.filter.service ? ` from ${rule.filter.service}` : "";
  return `${measured}${service} in the last ${windowLabel(rule.windowMinutes)}`;
}

export function describeAlertCondition(comparator: AlertComparator, threshold: number, unit: AlertValueUnit = "none"): string {
  return `${comparator === "gt" ? "above" : "below"} ${formatAlertValue(threshold, unit)}`;
}

export interface AlertMessageInput {
  alertName: string;
  alertUrl: string | null;
  groupBy: string | null;
  groupKey: string;
  rule: Pick<AlertRule, "aggregation" | "comparator" | "field" | "filter" | "metricName" | "source" | "threshold" | "windowMinutes">;
  value: number;
}

function groupLabel(input: Pick<AlertMessageInput, "groupBy" | "groupKey">): string {
  if (!input.groupBy) return "";
  return ` for ${slackText(alertFieldLabel(input.groupBy).replace(/^AI /u, ""))} ${slackText(input.groupKey || "(none)")}`;
}

// The message posted when an episode opens.
export function alertFiringMessage(input: AlertMessageInput): { markdown: string; text: string } {
  const group = groupLabel(input);
  const unit = alertValueUnit(input.rule);
  const link = input.alertUrl ? `\n\n[View alert](${input.alertUrl})` : "";
  return {
    markdown:
      `:rotating_light: **${slackText(input.alertName)}** is firing${group}.\n\n` +
      `${slackText(describeAlertRule(input.rule))}: **${formatAlertValue(input.value, unit)}**, ` +
      `${describeAlertCondition(input.rule.comparator, input.rule.threshold, unit)}.${link}`,
    text: `${slackText(input.alertName)} is firing${group}`,
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
  const unit = alertValueUnit(input.rule);
  return {
    markdown:
      `:white_check_mark: **${slackText(input.alertName)}** recovered${group} after ${durationLabel(input.firingForMs)}. ` +
      `The value is **${formatAlertValue(input.value, unit)}**, ${back} ${formatAlertValue(input.rule.threshold, unit)}.`,
    text: `${slackText(input.alertName)} recovered${group}`,
  };
}
