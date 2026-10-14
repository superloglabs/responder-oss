import type { TelemetryClient } from "./client.js";
import type { AlertRule } from "./alerts.js";
import { countSeries, metricAggregate, pickStep } from "./query.js";

export type AlertValueRow = { group: string; value: number };

// The window an alert is checked over, ending now.
export function alertWindow(windowMinutes: number, now: Date): { since: string; until: string } {
  return { since: new Date(now.getTime() - windowMinutes * 60_000).toISOString(), until: now.toISOString() };
}

// One value per group over the alert's window: a count of logs or spans, or
// the sum or average of a metric. Groups are by `groupBy` when set, also for
// a rule evaluated as one total.
export async function alertValues(
  client: TelemetryClient,
  projectId: string,
  rule: Pick<AlertRule, "aggregation" | "filter" | "groupBy" | "metricName" | "source" | "windowMinutes">,
  now: Date,
): Promise<AlertValueRow[]> {
  const range = alertWindow(rule.windowMinutes, now);
  const groupBy = rule.groupBy || undefined;
  if (rule.source === "metric") {
    if (!rule.metricName) throw new Error("The alert has no metric");
    return metricAggregate(
      client,
      projectId,
      rule.metricName,
      { range, resourceAttrs: rule.filter.resourceAttrs ?? [], ...(rule.filter.service ? { service: rule.filter.service } : {}) },
      groupBy,
      rule.aggregation === "avg" ? "avg" : "sum",
    );
  }
  // A few buckets across the window, summed per group.
  const rows = await countSeries(
    client,
    projectId,
    rule.source,
    { ...rule.filter, range, resourceAttrs: rule.filter.resourceAttrs ?? [] },
    groupBy,
    pickStep(rule.windowMinutes * 60, 30),
  );
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.group, (totals.get(row.group) ?? 0) + row.count);
  return [...totals].map(([group, value]) => ({ group, value }));
}
