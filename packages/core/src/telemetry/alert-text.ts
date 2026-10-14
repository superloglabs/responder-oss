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
  return ` for ${slackText(input.groupBy.replace(/^attr:/u, ""))} ${slackText(input.groupKey || "(none)")}`;
}

// The message posted when an episode opens.
export function alertFiringMessage(input: AlertMessageInput): { markdown: string; text: string } {
  const group = groupLabel(input);
  const link = input.alertUrl ? `\n\n[View alert](${input.alertUrl})` : "";
  return {
    markdown:
      `:rotating_light: **${slackText(input.alertName)}** is firing${group}.\n\n` +
      `${slackText(describeAlertRule(input.rule))}: **${formatAlertValue(input.value)}**, ` +
      `${describeAlertCondition(input.rule.comparator, input.rule.threshold)}.${link}`,
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
  return {
    markdown:
      `:white_check_mark: **${slackText(input.alertName)}** recovered${group} after ${durationLabel(input.firingForMs)}. ` +
      `The value is **${formatAlertValue(input.value)}**, ${back} ${formatAlertValue(input.rule.threshold)}.`,
    text: `${slackText(input.alertName)} recovered${group}`,
  };
}
