import { type PointerEvent, useLayoutEffect, useRef, useState } from "react";
import type { HistogramBar } from "../telemetry-api";
import "./count-histogram.css";

export interface HistogramSeries<Series extends string> {
  // Swatch and bar color, as a CSS color.
  color: string;
  colorForValue?: (value: number) => string;
  formatValue?: (value: number) => string;
  label: string;
  name: Series;
}

// Axis labels under the chart.
const axisLabels = 7;

function formatTick(date: Date, withDate: boolean, timeZone: string | undefined): string {
  const zone = timeZone ? { timeZone } : {};
  return withDate
    ? date.toLocaleDateString(undefined, { ...zone, day: "numeric", month: "short" })
    : date.toLocaleTimeString(undefined, { ...zone, hour: "2-digit", hour12: false, minute: "2-digit" });
}

// The bucket's start, to the second when buckets are shorter than a minute.
function formatBucket(date: Date, stepMs: number, timeZone: string | undefined): string {
  return date.toLocaleString(undefined, {
    ...(timeZone ? { timeZone } : {}),
    day: "numeric",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    second: stepMs < 60_000 ? "2-digit" : undefined,
  });
}

// Counts per time bucket as thin bars in a pale track, each split into its
// series. `series` lists them top to bottom. A compact chart is shorter and
// has no time axis. Pointing at a bar shows its counts.
export function CountHistogram<Series extends string>({
  bars,
  compact = false,
  label,
  series,
  timeZone,
}: {
  bars: Array<HistogramBar<Series>> | null;
  compact?: boolean;
  label: string;
  series: Array<HistogramSeries<Series>>;
  timeZone?: string;
}) {
  // The bar under the pointer, and the chart's width then.
  const [pointer, setPointer] = useState<{ index: number; width: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipWidth, setTooltipWidth] = useState(0);
  const max = Math.max(1, ...(bars ?? []).map((bar) => bar.total));
  const first = bars?.[0]?.start;
  const last = bars?.at(-1)?.start;
  const withDate = Boolean(first && last && last.getTime() - first.getTime() > 86_400_000);
  const stepMs = bars && bars.length > 1 ? bars[1]!.start.getTime() - bars[0]!.start.getTime() : 60_000;
  const ticks = bars && bars.length > 1
    ? Array.from({ length: axisLabels }, (_, index) => bars[Math.round((index * (bars.length - 1)) / (axisLabels - 1))]!.start)
    : [];
  const hover = pointer?.index ?? null;
  const hovered = hover === null ? null : bars?.[hover] ?? null;

  useLayoutEffect(() => {
    if (tooltipRef.current) setTooltipWidth(tooltipRef.current.offsetWidth);
  }, [hovered]);

  function pointAt(event: PointerEvent<HTMLDivElement>) {
    if (!bars || bars.length === 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    const index = Math.floor(((event.clientX - box.left) / box.width) * bars.length);
    setPointer({ index: Math.max(0, Math.min(bars.length - 1, index)), width: box.width });
  }

  // Beside the bar, on the side with more room, and inside the chart.
  const tooltipLeft = (() => {
    if (!pointer || !bars) return 0;
    const { index, width } = pointer;
    const centre = ((index + 0.5) / bars.length) * width;
    const preferred = centre > width / 2 ? centre - 12 - tooltipWidth : centre + 12;
    return Math.max(0, Math.min(preferred, width - tooltipWidth));
  })();

  return (
    <div className={compact ? "countHistogram countHistogram--compact" : "countHistogram"}>
      <div className="countHistogram__plot">
        <div
          aria-label={label}
          className={bars ? "countHistogram__bars" : "countHistogram__bars countHistogram__bars--loading"}
          onPointerLeave={() => setPointer(null)}
          onPointerMove={pointAt}
          role="img"
        >
          {(bars ?? Array.from({ length: 60 }, () => null)).map((bar, index) => (
            <div
              className="countHistogram__track"
              data-hovered={index === hover || undefined}
              key={bar ? bar.start.getTime() : index}
            >
              {bar
                ? series.map((item) => bar.counts[item.name] > 0 ? (
                  <span
                    className="countHistogram__segment"
                    key={item.name}
                    style={{
                      background: item.colorForValue?.(bar.counts[item.name]) ?? item.color,
                      height: `max(2px, ${(bar.counts[item.name] / max) * 100}%)`,
                    }}
                  />
                ) : null)
                : null}
            </div>
          ))}
        </div>
        {hovered ? (
          <div className="countHistogram__tooltip" ref={tooltipRef} style={{ transform: `translateX(${tooltipLeft}px)` }}>
            <time dateTime={hovered.start.toISOString()}>{formatBucket(hovered.start, stepMs, timeZone)}</time>
            <dl>
              {series.map((item) => (
                <div key={item.name}>
                  <dt><span aria-hidden="true" style={{ background: item.colorForValue?.(hovered.counts[item.name]) ?? item.color }} />{item.label}</dt>
                  <dd>{item.formatValue ? item.formatValue(hovered.counts[item.name]) : hovered.counts[item.name].toLocaleString()}</dd>
                </div>
              ))}
              {series.length > 1 ? (
                <div className="countHistogram__total">
                  <dt>Total</dt>
                  <dd>{hovered.total.toLocaleString()}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        ) : null}
      </div>
      {compact ? null : (
        <div aria-hidden="true" className="countHistogram__axis">
          {ticks.map((tick, index) => <span key={index}>{formatTick(tick, withDate, timeZone)}</span>)}
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
