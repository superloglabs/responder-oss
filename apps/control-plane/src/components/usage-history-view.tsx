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

export function UsageRangeControl({
  onChange,
  value,
}: {
  onChange: (value: UsageHistoryDays) => void;
  value: UsageHistoryDays;
}) {
  return (
    <div aria-label="Time range" className="usageRange" role="radiogroup">
      {usageRangeOptions.map((option) => (
        <button
          aria-checked={option.value === value}
          key={option.value}
          onClick={() => onChange(option.value)}
          role="radio"
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
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
