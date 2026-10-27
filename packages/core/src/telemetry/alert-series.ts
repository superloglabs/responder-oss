import type { AlertRule } from "./alerts.js";
import type { TelemetryClient } from "./client.js";
import { alertMetricIdentity, alertWindow } from "./alert-values.js";
import { aiPriceParamsFor } from "./ai-price-params.js";
import { countSeries, eventSeries, metricSeries } from "./query.js";

// The chart covers this many windows of the rule.
export const chartWindows = 24;

function windowStep(windowMinutes: number) {
  return windowMinutes % 1_440 === 0
    ? { n: windowMinutes / 1_440, unit: "DAY" as const }
    : windowMinutes % 60 === 0
      ? { n: windowMinutes / 60, unit: "HOUR" as const }
      : { n: windowMinutes, unit: "MINUTE" as const };
}

export async function alertSeries(client: TelemetryClient, organizationId: string, rule: AlertRule, now: Date, requestedRange?: { since: string; until: string }, groupValue?: string) {
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
      { ...alertMetricIdentity(rule.filter), groupValue },
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
      groupValue,
    );
  }
  const rows = await countSeries(
    client,
    organizationId,
    rule.source,
    { ...rule.filter, range, resourceAttrs: rule.filter.resourceAttrs ?? [] },
    groupBy,
    step,
    groupValue,
  );
  return rows.map((row) => ({ bucket: row.bucket, group: row.group, value: row.count }));
}
