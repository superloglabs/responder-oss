import type { AlertForm } from "../alerts-api";
import type { ChartData } from "../dashboards-api";
import { ChartSkeleton } from "./screen-skeletons";
import { TimeseriesChart } from "./timeseries-chart";
import { alertValueUnit } from "../../../../packages/core/src/telemetry/alert-text";

export function AlertChart({
  chart,
  error,
  loading,
  rule,
  showThreshold = true,
  highlights = [],
}: {
  chart?: ChartData | null;
  error?: string | null;
  loading?: boolean;
  rule: Pick<AlertForm, "aggregation" | "field" | "source" | "threshold">;
  showThreshold?: boolean;
  highlights?: Array<{ start: number; end: number; label: string }>;
}) {
  const unit = alertValueUnit({ ...rule, field: rule.field || null });
  const threshold = rule.threshold.trim() ? Number(rule.threshold) : undefined;
  return (
    <div className="alertChart__plot" aria-busy={loading}>
      {error ? (
        <p className="alertEmpty" role="alert">
          {error}
        </p>
      ) : loading ? (
        <ChartSkeleton height="100%" label="Loading chart…" />
      ) : chart && chart.series.length > 0 ? (
        <TimeseriesChart
          chart={chart}
          chartType="line"
          label={showThreshold ? "Values and alert threshold" : "Matching data over time"}
          showLegend={chart.series.length > 1}
          highlights={highlights}
          {...(showThreshold && threshold !== undefined && Number.isFinite(threshold) ? { threshold } : {})}
          unit={unit === "ms" ? "duration_ms" : unit}
        />
      ) : (
        <p className="alertEmpty">No matching data in this time range.</p>
      )}
    </div>
  );
}
