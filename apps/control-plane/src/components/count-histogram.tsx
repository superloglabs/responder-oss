import type { HistogramBar } from "../telemetry-api";
import "./count-histogram.css";

export interface HistogramSeries<Series extends string> {
  // Swatch and bar color, as a CSS color.
  color: string;
  label: string;
  name: Series;
}

// Axis labels under the chart.
const axisLabels = 7;

function formatTick(date: Date, withDate: boolean): string {
  return withDate
    ? date.toLocaleDateString(undefined, { day: "numeric", month: "short" })
    : date.toLocaleTimeString(undefined, { hour: "2-digit", hour12: false, minute: "2-digit" });
}

// Counts per time bucket as thin bars in a pale track, each split into its
// series. `series` lists them top to bottom. A compact chart is shorter and
// has no time axis.
export function CountHistogram<Series extends string>({
  bars,
  compact = false,
  label,
  series,
}: {
  bars: Array<HistogramBar<Series>> | null;
  compact?: boolean;
  label: string;
  series: Array<HistogramSeries<Series>>;
}) {
  const max = Math.max(1, ...(bars ?? []).map((bar) => bar.total));
  const first = bars?.[0]?.start;
  const last = bars?.at(-1)?.start;
  const withDate = Boolean(first && last && last.getTime() - first.getTime() > 86_400_000);
  const ticks = bars && bars.length > 1
    ? Array.from({ length: axisLabels }, (_, index) => bars[Math.round((index * (bars.length - 1)) / (axisLabels - 1))]!.start)
    : [];
  return (
    <div className={compact ? "countHistogram countHistogram--compact" : "countHistogram"}>
      <div aria-label={label} className={bars ? "countHistogram__bars" : "countHistogram__bars countHistogram__bars--loading"} role="img">
        {(bars ?? Array.from({ length: 60 }, () => null)).map((bar, index) => (
          <div
            className="countHistogram__track"
            key={bar ? bar.start.getTime() : index}
            title={bar
              ? `${formatTick(bar.start, withDate)} ${bar.start.toLocaleTimeString(undefined, { hour12: false })}\n${series
                .map((item) => `${item.label}: ${bar.counts[item.name].toLocaleString()}`)
                .join("\n")}`
              : undefined}
          >
            {bar
              ? series.map((item) => bar.counts[item.name] > 0 ? (
                <span
                  className="countHistogram__segment"
                  key={item.name}
                  style={{
                    background: item.color,
                    height: `max(2px, ${(bar.counts[item.name] / max) * 100}%)`,
                  }}
                />
              ) : null)
              : null}
          </div>
        ))}
      </div>
      {compact ? null : (
        <div aria-hidden="true" className="countHistogram__axis">
          {ticks.map((tick, index) => <span key={index}>{formatTick(tick, withDate)}</span>)}
        </div>
      )}
    </div>
  );
}

export function HistogramLegend<Series extends string>({
  bars,
  series,
}: {
  bars: Array<HistogramBar<Series>> | null;
  series: Array<HistogramSeries<Series>>;
}) {
  return (
    <>
      {series.map((item) => (
        <span className="countHistogram__legend" key={item.name}>
          <span aria-hidden="true" style={{ background: item.color }} />
          {item.label}{" "}
          {bars ? bars.reduce((sum, bar) => sum + bar.counts[item.name], 0).toLocaleString() : "…"}
        </span>
      ))}
    </>
  );
}
