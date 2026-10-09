import type { KeyboardEvent } from "react";
import {
  formatUsage,
  usageChart,
  usageMetricLabels,
  type UsageHistory,
  type UsageHistoryDays,
  type UsageMetric,
} from "../usage-history-presentation";
import { UsageChart } from "./usage-chart";

const usageRangeOptions: Array<{ label: string; value: UsageHistoryDays }> = [
  { label: "7 days", value: 7 },
  { label: "30 days", value: 30 },
  { label: "90 days", value: 90 },
];

// A single-choice group following the radio group pattern: Tab reaches the
// selected option and the arrow keys, Home, and End change the selection.
export function UsageChoiceGroup<Value extends string | number>({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: Value) => void;
  options: Array<{ label: string; value: Value }>;
  value: Value;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = options.findIndex((option) => option.value === value);
    const last = options.length - 1;
    const next =
      event.key === "ArrowLeft" || event.key === "ArrowUp" ? (current <= 0 ? last : current - 1)
        : event.key === "ArrowRight" || event.key === "ArrowDown" ? (current >= last ? 0 : current + 1)
          : event.key === "Home" ? 0
            : event.key === "End" ? last
              : null;
    const option = next === null ? undefined : options[next];
    if (!option) return;
    event.preventDefault();
    onChange(option.value);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[next ?? 0]?.focus();
  }
  return (
    <div aria-label={label} className="usageRange" onKeyDown={onKeyDown} role="radiogroup">
      {options.map((option) => (
        <button
          aria-checked={option.value === value}
          key={option.value}
          onClick={() => onChange(option.value)}
          role="radio"
          tabIndex={option.value === value ? 0 : -1}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function UsageRangeControl({
  onChange,
  value,
}: {
  onChange: (value: UsageHistoryDays) => void;
  value: UsageHistoryDays;
}) {
  return <UsageChoiceGroup label="Time range" onChange={onChange} options={usageRangeOptions} value={value} />;
}

// One metric of one automation, as a headline total over a daily chart.
export function UsageMetricCard({
  history,
  metric,
  note,
}: {
  history: UsageHistory;
  metric: UsageMetric;
  note: string;
}) {
  const chart = usageChart(history, metric);
  return (
    <section className="usageCard">
      <header className="usageCard__header">
        <h2>{usageMetricLabels[metric]}</h2>
        <strong>{formatUsage(metric, chart.total)}</strong>
        <p>{note}</p>
      </header>
      <UsageChart chart={chart} label={`${usageMetricLabels[metric]} per day`} metric={metric} />
    </section>
  );
}
