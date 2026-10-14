import { ChartBarIcon, GaugeIcon, SigmaIcon } from "@phosphor-icons/react";
import { metricKindLabel, type MetricKind } from "../metrics-api";

// Gauges read a level, sums add up, histograms and summaries hold a spread.
export function MetricKindIcon({ kind }: { kind: MetricKind }) {
  const Icon = kind === "gauge" ? GaugeIcon : kind === "sum" ? SigmaIcon : ChartBarIcon;
  return (
    <span aria-label={metricKindLabel(kind)} className="metricKindIcon" role="img" title={metricKindLabel(kind)}>
      <Icon aria-hidden="true" size={14} />
    </span>
  );
}
