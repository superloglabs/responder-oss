import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { axisTicks, formatWidgetValue, type ChartData, type WidgetUnit } from "../dashboards-api";
import "./timeseries-chart.css";

// Series take `timeseriesChart__color--<index % seriesColors>`, also in
// legends drawn outside the chart.
export const seriesColors = 8;

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ height: 0, width: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ height: entry.contentRect.height, width: entry.contentRect.width });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

function timeLabel(time: number, spanMs: number): string {
  const date = new Date(time);
  return spanMs > 2 * 86_400_000
    ? date.toLocaleDateString(undefined, { day: "numeric", month: "short" })
    : date.toLocaleTimeString(undefined, { hour: "2-digit", hour12: false, minute: "2-digit" });
}

function seriesTotal(values: Array<number | null>): number {
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

// One line or stacked column per series over time, with a legend that hides
// and shows series and a tooltip for the bucket under the pointer.
export function TimeseriesChart({
  chart,
  chartType = "bar",
  hiddenSeries,
  label,
  legendPosition = "bottom",
  showLegend = true,
  showXAxis = true,
  showYAxis = true,
  threshold,
  unit = "none",
}: {
  chart: ChartData;
  chartType?: "bar" | "line";
  // Series hidden by a legend outside the chart. Without it the chart's own
  // legend hides and shows series.
  hiddenSeries?: ReadonlySet<string>;
  label: string;
  legendPosition?: "bottom" | "side";
  showLegend?: boolean;
  showXAxis?: boolean;
  showYAxis?: boolean;
  // Drawn as a dashed line, for an alert's condition.
  threshold?: number;
  unit?: WidgetUnit;
}) {
  const { ref, size } = useSize<HTMLDivElement>();
  const [ownHidden, setHidden] = useState<Set<string>>(new Set());
  const hidden = hiddenSeries ?? ownHidden;
  const [hover, setHover] = useState<number | null>(null);
  const visible = useMemo(() => chart.series.filter((series) => !hidden.has(series.name)), [chart.series, hidden]);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipWidth, setTooltipWidth] = useState(0);
  const colorOf = useMemo(
    () => new Map(chart.series.map((series, index) => [series.name, index % seriesColors])),
    [chart.series],
  );
  const count = chart.buckets.length;
  const stacked = chartType === "bar";

  const { maximum, minimum } = useMemo(() => {
    let low = 0;
    let high = 0;
    for (let index = 0; index < count; index += 1) {
      let positive = 0;
      let negative = 0;
      for (const series of visible) {
        const value = series.values[index] ?? 0;
        if (stacked) {
          if (value >= 0) positive += value;
          else negative += value;
        } else {
          high = Math.max(high, value);
          low = Math.min(low, value);
        }
      }
      if (stacked) {
        high = Math.max(high, positive);
        low = Math.min(low, negative);
      }
    }
    if (threshold !== undefined) {
      high = Math.max(high, threshold);
      low = Math.min(low, threshold);
    }
    return { maximum: high, minimum: low };
  }, [count, stacked, threshold, visible]);

  const ticks = axisTicks(minimum, maximum);
  const top = ticks[ticks.length - 1]!;
  const bottom = ticks[0]!;
  const left = showYAxis ? 52 : 4;
  const footer = showXAxis ? 20 : 4;
  const width = Math.max(0, size.width - left - 4);
  const height = Math.max(0, size.height - footer - 6);
  const y = (value: number) => 6 + height - ((value - bottom) / (top - bottom || 1)) * height;
  const band = count > 0 ? width / count : width;
  const x = (index: number) => left + (stacked ? index * band + band / 2 : count > 1 ? (index / (count - 1)) * width : width / 2);
  const spanMs = count > 1 ? chart.buckets[count - 1]! - chart.buckets[0]! : 0;
  const labelEvery = Math.max(1, Math.ceil(count / Math.max(1, Math.floor(width / 90))));

  function onMove(event: MouseEvent<SVGSVGElement>) {
    if (count === 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const offset = event.clientX - bounds.left - left;
    const index = stacked ? Math.floor(offset / band) : Math.round((offset / (width || 1)) * (count - 1));
    setHover(index >= 0 && index < count ? index : null);
  }

  const columns = stacked
    ? chart.buckets.map((_, index) => {
        let positive = 0;
        let negative = 0;
        return visible.flatMap((series) => {
          const value = series.values[index] ?? 0;
          if (value === 0) return [];
          const from = value >= 0 ? positive : negative;
          if (value >= 0) positive += value;
          else negative += value;
          const to = from + value;
          return [{ from, name: series.name, to }];
        });
      })
    : [];

  // Joins the points with data. Metrics often report less often than the
  // bucket size, so empty buckets between points are bridged.
  const linePath = (values: Array<number | null>) =>
    values
      .flatMap((value, index) => (value === null ? [] : [`${x(index).toFixed(1)},${y(value).toFixed(1)}`]))
      .map((point, index) => `${index === 0 ? "M" : "L"}${point}`)
      .join("");
  const singlePoints = (values: Array<number | null>) =>
    values.filter((value) => value !== null).length === 1 ? values.findIndex((value) => value !== null) : -1;

  const hoverValues = hover === null
    ? []
    : visible
        .map((series) => ({ name: series.name, value: series.values[hover] ?? null }))
        .filter((row) => row.value !== null)
        .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const hoverRows = hoverValues.slice(0, 10);
  // Beside the pointer, on whichever side has room, and inside the plot.
  const tooltipLeft = (() => {
    if (hover === null) return 0;
    const pointer = x(hover);
    const preferred = pointer > size.width / 2 ? pointer - 12 - tooltipWidth : pointer + 12;
    return Math.max(0, Math.min(preferred, size.width - tooltipWidth));
  })();

  useEffect(() => {
    if (tooltipRef.current) setTooltipWidth(tooltipRef.current.offsetWidth);
  }, [hover, hoverRows.length]);

  const legend = showLegend && chart.series.length > 0 ? (
    <ul aria-label="Series" className="timeseriesChart__legend">
      {chart.series.map((series) => (
        <li key={series.name}>
          <button
            aria-pressed={!hidden.has(series.name)}
            onClick={() =>
              setHidden((current) => {
                const next = new Set(current);
                if (next.has(series.name)) next.delete(series.name);
                else next.add(series.name);
                return next;
              })
            }
            type="button"
          >
            <span className={`timeseriesChart__swatch timeseriesChart__color--${colorOf.get(series.name)}`} />
            <span className="timeseriesChart__seriesName" title={series.name}>{series.name}</span>
            <span className="timeseriesChart__seriesTotal">
              {formatWidgetValue(stacked ? seriesTotal(series.values) : Math.max(...series.values.map((value) => value ?? -Infinity)), unit)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  ) : null;

  return (
    <figure className="timeseriesChart">
      <div className={`timeseriesChart__layout timeseriesChart--legend-${legendPosition}`}>
      <div className="timeseriesChart__plot" ref={ref}>
        {size.width > 0 ? (
          <svg
            aria-label={label}
            height={size.height}
            onMouseLeave={() => setHover(null)}
            onMouseMove={onMove}
            role="img"
            width={size.width}
          >
            {ticks.map((tick) => (
              <g key={tick}>
                <line className="timeseriesChart__grid" x1={left} x2={left + width} y1={y(tick)} y2={y(tick)} />
                {showYAxis ? (
                  <text className="timeseriesChart__axis" textAnchor="end" x={left - 8} y={y(tick) + 4}>
                    {tick === 0 ? "0" : formatWidgetValue(tick, unit)}
                  </text>
                ) : null}
              </g>
            ))}
            {showXAxis
              ? chart.buckets.map((time, index) =>
                  index % labelEvery === 0 ? (
                    <text
                      className="timeseriesChart__axis"
                      key={time}
                      textAnchor="middle"
                      x={x(index)}
                      y={6 + height + 15}
                    >
                      {timeLabel(time, spanMs)}
                    </text>
                  ) : null,
                )
              : null}
            {hover !== null ? (
              stacked ? (
                <rect className="timeseriesChart__hover" height={height} width={band} x={left + hover * band} y={6} />
              ) : (
                <line className="timeseriesChart__cursor" x1={x(hover)} x2={x(hover)} y1={6} y2={6 + height} />
              )
            ) : null}
            {stacked
              ? columns.map((segments, index) =>
                  segments.map((segment) => (
                    <rect
                      className={`timeseriesChart__bar timeseriesChart__color--${colorOf.get(segment.name)}`}
                      height={Math.max(0.5, Math.abs(y(segment.from) - y(segment.to)))}
                      key={`${index}-${segment.name}`}
                      width={Math.max(1, band - Math.min(2, band * 0.2))}
                      x={left + index * band + Math.min(1, band * 0.1)}
                      y={Math.min(y(segment.from), y(segment.to))}
                    />
                  )),
                )
              : visible.map((series) => {
                  const single = singlePoints(series.values);
                  return single >= 0 ? (
                    <circle
                      className={`timeseriesChart__point timeseriesChart__color--${colorOf.get(series.name)}`}
                      cx={x(single)}
                      cy={y(series.values[single]!)}
                      key={series.name}
                      r={2.5}
                    />
                  ) : (
                    <path
                      className={`timeseriesChart__line timeseriesChart__color--${colorOf.get(series.name)}`}
                      d={linePath(series.values)}
                      key={series.name}
                    />
                  );
                })}
            {/* Drawn last, so bars crossing it do not hide it. */}
            {threshold !== undefined ? (
              <line className="timeseriesChart__threshold" x1={left} x2={left + width} y1={y(threshold)} y2={y(threshold)} />
            ) : null}
          </svg>
        ) : null}
        {hover !== null && hoverRows.length > 0 ? (
          <div className="timeseriesChart__tooltip" ref={tooltipRef} style={{ transform: `translateX(${tooltipLeft}px)` }}>
            <time>{new Date(chart.buckets[hover]!).toLocaleString(undefined, { day: "numeric", hour: "2-digit", hour12: false, minute: "2-digit", month: "short", second: chart.stepMs < 60_000 ? "2-digit" : undefined })}</time>
            <dl>
              {hoverRows.map((row) => (
                <div key={row.name}>
                  <dt>
                    <span className={`timeseriesChart__swatch timeseriesChart__color--${colorOf.get(row.name)}`} />
                    {row.name}
                  </dt>
                  <dd>{formatWidgetValue(row.value, unit)}</dd>
                </div>
              ))}
            </dl>
            {hoverValues.length > hoverRows.length ? (
              <p className="timeseriesChart__more">{hoverValues.length - hoverRows.length} more</p>
            ) : null}
          </div>
        ) : null}
      </div>
      {legend}
      </div>
    </figure>
  );
}
