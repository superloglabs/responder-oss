import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { alertSeries, chartWindows } from "@responder/core/telemetry/alert-series";
import { alertCountsEmptyAsZero, type AlertRule } from "@responder/core/telemetry/alerts";
import { alertValueUnit, describeAlertCondition, describeAlertRule, formatAlertValue } from "@responder/core/telemetry/alert-text";
import type { TelemetryClient } from "@responder/core/telemetry/client";
import { chartSeries, type ChartData } from "@responder/core/telemetry/dashboards";

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

// The graph uses the same window-sized buckets as the alert detail page.
// Each bar spans one bucket; no interpolated values or separate evaluation point.
export function alertChartSvg(input: {
  chart: ChartData;
  groupKey: string;
  now: Date;
  rule: AlertRule & { name: string };
}): string {
  const { chart, rule, now } = input;
  const unit = alertValueUnit(rule);
  const format = (n: number) => xml(formatAlertValue(n, unit));
  const step = rule.windowMinutes * 60_000;
  const until = Math.ceil(now.getTime() / step) * step;
  const since = until - chartWindows * step;
  const samples = chart.series[0]?.values ?? chart.buckets.map(() => alertCountsEmptyAsZero(rule) ? 0 : null);
  const finite = [0, rule.threshold, ...samples.filter((v, i): v is number => chart.buckets[i]! >= since && chart.buckets[i]! < until && v !== null && Number.isFinite(v))];
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const rawStep = (max - min || Math.abs(max) || 1) / 3;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  let tickStep = [1, 2, 5, 10].find((n) => n * magnitude >= rawStep)! * magnitude;
  if (rule.aggregation === "count" || rule.aggregation === "count_distinct") tickStep = Math.max(1, tickStep);
  const low = Math.floor(min / tickStep) * tickStep;
  const high = Math.max(low + tickStep, Math.ceil(max / tickStep) * tickStep);
  const ticks = Array.from({ length: Math.round((high - low) / tickStep) + 1 }, (_, i) => low + i * tickStep);
  const x = (time: number) => 52 + (time - since) / (until - since) * 688;
  const y = (n: number) => 197 - (n - low) / (high - low) * 116;
  const bars = chart.buckets.flatMap((time, i) => {
    const sample = samples[i];
    if (time < since || time >= until || sample == null || !Number.isFinite(sample) || sample === 0) return [];
    const breaching = rule.comparator === "gt" ? sample > rule.threshold : sample < rule.threshold;
    return [`<rect x="${x(time) + 2}" y="${Math.min(y(0), y(sample))}" width="${x(time + step) - x(time) - 4}" height="${Math.abs(y(sample) - y(0))}" fill="${breaching ? "#D92D20" : "#4E58F9"}" rx="1"/>`];
  }).join("");
  const timeLabel = (time: number) => new Date(time).toISOString().slice(11, 16);
  const period = (minutes: number) => minutes % 1440 === 0 ? `${minutes / 1440} days` : minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes} minutes`;
  const measure = rule.aggregation === "count"
    ? rule.source === "logs" ? rule.filter.severity === "error" ? "Errors" : "Logs" : "Spans"
    : describeAlertRule({ ...rule, filter: {}, windowMinutes: rule.windowMinutes }).split(" in the last ")[0]!;
  const title = `${measure} per ${period(rule.windowMinutes)}`;
  const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(now);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="296" viewBox="0 0 768 296">
  <rect x="0.5" y="0.5" width="767" height="295" rx="8" fill="#FFFFFF" stroke="#E8E8E8"/>
  <g font-family="Inter" fill="#202020">
    <text x="24" y="35" font-size="14" font-weight="600">${xml(title.slice(0, 75))}</text>
    <text x="744" y="35" font-size="13" fill="#666666" text-anchor="end">Last ${period(rule.windowMinutes * chartWindows)}</text>
    ${ticks.map((n) => `<line x1="52" x2="740" y1="${y(n)}" y2="${y(n)}" stroke="#F0F0F0"/><text x="36" y="${y(n) + 4}" text-anchor="end" font-size="12" fill="#666666">${format(n)}</text>`).join("")}
    <line x1="52" x2="740" y1="${y(rule.threshold)}" y2="${y(rule.threshold)}" stroke="#888888" stroke-width="1" stroke-dasharray="3 3"/>
    ${bars}
    <text x="52" y="229" font-size="12" fill="#666666">${timeLabel(since)}</text>
    <text x="396" y="229" text-anchor="middle" font-size="12" fill="#666666">${timeLabel((since + until) / 2)}</text>
    <text x="740" y="229" text-anchor="end" font-size="12" fill="#666666">${timeLabel(until)}</text>
    <line x1="24" x2="44" y1="266" y2="266" stroke="#888888" stroke-width="1" stroke-dasharray="3 3"/>
    <text x="52" y="270" font-size="13" fill="#444444">Alert when ${xml(describeAlertCondition(rule.comparator, rule.threshold, unit))}</text>
    <text x="744" y="270" text-anchor="end" font-size="12" fill="#666666">${date} · UTC</text>
  </g></svg>`;
}

export async function renderAlertChart(input: {
  client: TelemetryClient;
  groupKey: string;
  now: Date;
  organizationId: string;
  rule: AlertRule & { name: string };
}): Promise<{ altText: string; png: Buffer }> {
  const { rule, now } = input;
  const step = rule.windowMinutes * 60_000;
  const until = Math.ceil(now.getTime() / step) * step;
  const range = { since: new Date(until - chartWindows * step).toISOString(), until: now.toISOString() };
  const rows = await alertSeries(input.client, input.organizationId, rule, now, range,
    rule.groupMode === "per_group" ? input.groupKey : undefined);
  const chart = chartSeries(rows, {
    fill: alertCountsEmptyAsZero(rule) ? "zero" : "null",
    limit: 1,
    other: false,
    sinceMs: Date.parse(range.since),
    untilMs: Date.parse(range.until),
    stepMs: rule.windowMinutes * 60_000,
  });
  const svg = alertChartSvg({ ...input, chart });
  const png = new Resvg(svg, {
    // Preserve sharp text on high-density Slack displays.
    fitTo: { mode: "zoom", value: 3 },
    font: { fontFiles: [fileURLToPath(new URL("../assets/Inter.ttf", import.meta.url))], loadSystemFonts: false, defaultFontFamily: "Inter" },
  }).render().asPng();
  return {
    altText: `${rule.name}: ${input.groupKey || "all matching data"}. Alert when ${describeAlertCondition(rule.comparator, rule.threshold, alertValueUnit(rule))}. Values per ${rule.windowMinutes} minutes.`.slice(0, 2000),
    png,
  };
}
