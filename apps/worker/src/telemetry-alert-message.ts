import { describeAlertRule, formatAlertValue, alertValueUnit, slackText, type AlertMessageInput } from "@responder/core/telemetry/alert-text";

// Native Slack text surrounds the image. The sender/avatar are provided by Slack.
export function alertImageLayout(input: AlertMessageInput): { before: unknown[]; after: unknown[] } {
  const rule = input.rule;
  const value = formatAlertValue(input.value, alertValueUnit(rule));
  const summary = rule.source === "logs" && rule.aggregation === "count"
    ? `${value} ${rule.filter.severity === "error" ? (input.value === 1 ? "error" : "errors") : (input.value === 1 ? "log" : "logs")}${rule.filter.service ? ` from ${slackText(rule.filter.service)}` : ""} in the last ${rule.windowMinutes} ${rule.windowMinutes === 1 ? "minute" : "minutes"}.`
    : `${slackText(describeAlertRule(rule))}: ${value}.`;
  return {
    before: [
      { type: "context", elements: [{ type: "mrkdwn", text: `:red_circle: *Firing*${input.groupBy ? `   ${slackText(input.groupBy)}: ${slackText(input.groupKey || "(none)")}` : ""}` }] },
      { type: "markdown", text: `**${slackText(input.alertName)}**\n\n${summary}` },
    ],
    after: input.alertUrl ? [{ type: "markdown", text: `[View alert](${input.alertUrl})` }] : [],
  };
}
