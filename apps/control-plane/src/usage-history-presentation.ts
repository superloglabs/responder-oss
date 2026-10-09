import type {
  UsageHistory,
  UsageHistoryDays,
  UsageSource,
} from "../../../packages/core/src/db/usage-history";

export type { UsageHistory, UsageHistoryDays };

export type UsageMetric = "aiCharge" | "machineHours";

export const usageMetricLabels: Record<UsageMetric, string> = {
  aiCharge: "AI usage",
  machineHours: "Machine hours",
};

// Series colors are assigned in this order and never cycled. Sources past
// the last slot fold into "Other".
export const usageSeriesSlots = 7;
export const otherSeriesKey = "other";

export interface UsageSeries {
  key: string;
  label: string;
  // 1-based color slot. "Other" uses slot 8.
  slot: number;
  total: number;
}

export interface UsageColumn {
  day: string;
  // In series order; a series without usage that day is absent.
  segments: Array<{ series: string; value: number }>;
  total: number;
}

export interface UsageChart {
  columns: UsageColumn[];
  series: UsageSeries[];
  total: number;
}

export function usageSourceLabel(source: UsageSource): string {
  switch (source.kind) {
    case "automation":
      return source.name;
    case "deleted_automation":
      return "Deleted automations";
    case "investigations":
      return "Investigations";
    case "pull_requests":
      return "Pull requests";
    case "tag_mode":
      return "Tag mode";
  }
}

// Orders sources by their combined share of machine hours and AI usage, so
// a source keeps its place and color when the chart switches metric.
export function rankUsageSources(history: UsageHistory): string[] {
  const totals = new Map<string, Record<UsageMetric, number>>();
  const overall: Record<UsageMetric, number> = { aiCharge: 0, machineHours: 0 };
  for (const point of history.points) {
    const total = totals.get(point.source) ?? { aiCharge: 0, machineHours: 0 };
    total.aiCharge += point.aiCharge;
    total.machineHours += point.machineHours;
    totals.set(point.source, total);
    overall.aiCharge += point.aiCharge;
    overall.machineHours += point.machineHours;
  }
  const share = (total: Record<UsageMetric, number>) =>
    (overall.aiCharge > 0 ? total.aiCharge / overall.aiCharge : 0) +
    (overall.machineHours > 0 ? total.machineHours / overall.machineHours : 0);
  return [...totals.entries()]
    .filter(([, total]) => share(total) > 0)
    .sort(([leftKey, left], [rightKey, right]) => share(right) - share(left) || leftKey.localeCompare(rightKey))
    .map(([key]) => key);
}

// One stacked column per day, with series in source rank order.
export function usageChart(history: UsageHistory, metric: UsageMetric): UsageChart {
  const totals = new Map<string, number>();
  for (const point of history.points) {
    totals.set(point.source, (totals.get(point.source) ?? 0) + point[metric]);
  }
  const ranked = rankUsageSources(history);
  // Keep every source when they fit; otherwise fold the smallest into Other.
  const kept = ranked.length > usageSeriesSlots + 1 ? ranked.slice(0, usageSeriesSlots) : ranked;
  const keptKeys = new Set(kept.map((key) => key));
  const series: UsageSeries[] = kept.map((key, index) => ({
    key,
    label: history.sources[key] ? usageSourceLabel(history.sources[key]) : "Unknown",
    slot: index + 1,
    total: totals.get(key) ?? 0,
  }));
  const folded = ranked.filter((key) => !keptKeys.has(key));
  if (folded.length) {
    series.push({
      key: otherSeriesKey,
      label: "Other",
      slot: usageSeriesSlots + 1,
      total: folded.reduce((sum, key) => sum + (totals.get(key) ?? 0), 0),
    });
  }
  const order = new Map(series.map((entry, index) => [entry.key, index]));
  const byDay = new Map<string, Map<string, number>>();
  for (const point of history.points) {
    if (!(point[metric] > 0)) continue;
    const key = keptKeys.has(point.source) ? point.source : otherSeriesKey;
    const values = byDay.get(point.day) ?? new Map<string, number>();
    values.set(key, (values.get(key) ?? 0) + point[metric]);
    byDay.set(point.day, values);
  }
  const columns = history.days.map((day) => {
    const segments = [...(byDay.get(day) ?? new Map<string, number>()).entries()]
      .map(([key, value]) => ({ series: key, value }))
      .sort((left, right) => (order.get(left.series) ?? 0) - (order.get(right.series) ?? 0));
    return { day, segments, total: segments.reduce((sum, segment) => sum + segment.value, 0) };
  });
  return {
    columns,
    series,
    total: series.reduce((sum, entry) => sum + entry.total, 0),
  };
}

// Round axis steps: 1, 2, or 5 times a power of ten, so at most four
// gridlines sit above zero.
export function usageAxisTicks(maximum: number): number[] {
  if (!(maximum > 0)) return [0];
  const rough = maximum / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((factor) => factor * magnitude).find((value) => value >= rough) ?? rough;
  const ticks: number[] = [];
  for (let value = 0; value < maximum + step; value += step) {
    ticks.push(Number(value.toPrecision(12)));
    if (value >= maximum) break;
  }
  return ticks;
}

export function formatUsage(metric: UsageMetric, value: number): string {
  if (metric === "aiCharge") {
    if (value > 0 && value < 0.01) return "<$0.01";
    return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  }
  if (value > 0 && value < 0.1) return `${Math.max(1, Math.round(value * 60))} min`;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} h`;
}

// Axis ticks drop the cents and minutes that row values keep.
export function formatUsageTick(metric: UsageMetric, value: number): string {
  const digits = value !== 0 && Math.abs(value) < 1 ? 2 : value < 10 && !Number.isInteger(value) ? 1 : 0;
  const number = value.toLocaleString(undefined, { maximumFractionDigits: digits });
  return metric === "aiCharge" ? `$${number}` : `${number} h`;
}

export function usageDayLabel(day: string, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }): string {
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
}
