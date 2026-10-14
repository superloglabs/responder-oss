import type { TelemetryClient } from "./client.js";
import type { AlertFilter, AlertRule } from "./alerts.js";
import { countAggregate, metricAggregate } from "./query.js";

export type AlertValueRow = { group: string; value: number };

// The most groups a per-group alert evaluates. Past it the check fails rather
// than evaluate part of the groups.
export const maximumAlertGroups = 1_000;

// The one metric a rule reads when its name is sent as several kinds or units.
export function alertMetricIdentity(filter: AlertFilter): { kind?: NonNullable<AlertFilter["metricKind"]>; unit?: string } {
  return {
    ...(filter.metricKind ? { kind: filter.metricKind } : {}),
    ...(filter.metricUnit !== undefined ? { unit: filter.metricUnit } : {}),
  };
}

// The window an alert is checked over, ending now.
export function alertWindow(windowMinutes: number, now: Date): { since: string; until: string } {
  return { since: new Date(now.getTime() - windowMinutes * 60_000).toISOString(), until: now.toISOString() };
}

// One value per group over exactly the alert's window: a count of logs or
// spans, or the sum or average of a metric. A rule evaluated as one total is
// queried without grouping, so a metric average weighs every data point.
export async function alertValues(
  client: TelemetryClient,
  projectId: string,
  rule: Pick<AlertRule, "aggregation" | "filter" | "groupBy" | "groupMode" | "metricName" | "source" | "windowMinutes">,
  now: Date,
): Promise<AlertValueRow[]> {
  const range = alertWindow(rule.windowMinutes, now);
  const groupBy = rule.groupMode === "per_group" && rule.groupBy ? rule.groupBy : undefined;
  let rows: AlertValueRow[];
  if (rule.source === "metric") {
    if (!rule.metricName) throw new Error("The alert has no metric");
    rows = await metricAggregate(
      client,
      projectId,
      rule.metricName,
      { range, resourceAttrs: rule.filter.resourceAttrs ?? [], ...(rule.filter.service ? { service: rule.filter.service } : {}) },
      groupBy,
      rule.aggregation === "avg" ? "avg" : "sum",
      alertMetricIdentity(rule.filter),
    );
    // metricAggregate returns at most this many groups.
    if (groupBy && rows.length >= maximumAlertGroups) throw tooManyGroups();
  } else {
    rows = await countAggregate(
      client,
      projectId,
      rule.source,
      { ...rule.filter, range, resourceAttrs: rule.filter.resourceAttrs ?? [] },
      groupBy,
      maximumAlertGroups + 1,
    );
    if (rows.length > maximumAlertGroups) throw tooManyGroups();
  }
  return rows;
}

function tooManyGroups(): Error {
  return new Error(`The alert has more than ${maximumAlertGroups.toLocaleString("en-US")} groups. Narrow it with a filter.`);
}
