import { type MouseEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
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

function timeLabel(time: number, spanMs: number, timeZone: string | undefined): string {
  const date = new Date(time);
  const zone = timeZone ? { timeZone } : {};
  return spanMs > 2 * 86_400_000
    ? date.toLocaleDateString(undefined, { ...zone, day: "numeric", month: "short" })
    : date.toLocaleTimeString(undefined, { ...zone, hour: "2-digit", hour12: false, minute: "2-digit" });
}

// A drag shorter than this is a click, not a selection.
const minimumDragPixels = 6;

function seriesTotal(values: Array<number | null>): number {
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

// One line or stacked column per series over time, with a legend that hides
// and shows series and a tooltip for the bucket under the pointer.
export function TimeseriesChart({
  chart,
  adjacentBars = false,
  chartType = "bar",
  density = "default",
  hiddenSeries,
  highlights = [],
  label,
  legendPosition = "bottom",
  onZoom,
  showLegend = true,
  showXAxis = true,
  showYAxis = true,
  threshold,
  timeZone,
  unit = "none",
}: {
  chart: ChartData;
  adjacentBars?: boolean;
  chartType?: "bar" | "line";
  density?: "default" | "compact";
  // Series hidden by a legend outside the chart, which replaces the chart's
  // own legend. Without it the chart's own legend hides and shows series.
  hiddenSeries?: ReadonlySet<string>;
  highlights?: Array<{ start: number; end: number; label: string }>;
  label: string;
  legendPosition?: "bottom" | "side";
  // Dragging across the plot selects a window, in milliseconds.
  onZoom?: (since: number, until: number) => void;
  showLegend?: boolean;
  showXAxis?: boolean;
  showYAxis?: boolean;
  // Drawn as a dashed line, for an alert's condition.
  threshold?: number;
  // Times read in this zone, or the browser's.
  timeZone?: string;
  unit?: WidgetUnit;
}) {
  const { ref, size } = useSize<HTMLDivElement>();
  const gradientId = useId();
  const [ownHidden, setHidden] = useState<Set<string>>(new Set());
  const hidden = hiddenSeries ?? ownHidden;
  const [hover, setHover] = useState<number | null>(null);
  // Plot offsets, in pixels, where a drag started and where the pointer is.
  const [drag, setDrag] = useState<{ current: number; start: number } | null>(null);
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
  const axisLabels = ticks.map((tick) => tick === 0 ? "0" : formatWidgetValue(tick, unit));
  const axisLabelKey = axisLabels.join("\n");
  const [axisLabelWidth, setAxisLabelWidth] = useState(0);
  useLayoutEffect(() => {
    const labels = ref.current?.querySelectorAll<SVGTextElement>(".timeseriesChart__axis--y");
    if (!labels?.length) return;
    setAxisLabelWidth(Math.max(...Array.from(labels, (label) => label.getComputedTextLength())));
  }, [axisLabelKey, ref, showYAxis, size.width]);
  // Reserve only the label width and an 8px gap outside the data area.
  const left = showYAxis ? 4 + axisLabelWidth + 8 : 4;
  const plotTop = 6;
  const footer = showXAxis ? 20 : 4;
  const width = Math.max(0, size.width - left - 4);
  const height = Math.max(0, size.height - footer - plotTop);
  const y = (value: number) => plotTop + height - ((value - bottom) / (top - bottom || 1)) * height;
  const band = count > 0 ? width / count : width;
  const barWidth = adjacentBars ? band : Math.min(density === "compact" ? 6 : Infinity, Math.max(1, band - Math.min(2, band * 0.2)));
  const x = (index: number) => left + (stacked ? index * band + band / 2 : count > 1 ? (index / (count - 1)) * width : width / 2);
  const spanMs = count > 1 ? chart.buckets[count - 1]! - chart.buckets[0]! : 0;
  const labelEvery = Math.max(1, Math.ceil(count / Math.max(1, Math.floor(width / 90))));

  function plotOffset(event: MouseEvent<SVGSVGElement>): number {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.min(left + width, Math.max(left, event.clientX - bounds.left));
  }

  function onMove(event: MouseEvent<SVGSVGElement>) {
    if (count === 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const offset = event.clientX - bounds.left - left;
    const index = stacked ? Math.floor(offset / band) : Math.round((offset / (width || 1)) * (count - 1));
    setHover(index >= 0 && index < count ? index : null);
    if (drag) setDrag({ ...drag, current: plotOffset(event) });
  }

  // The time under a plot offset. A column covers its bucket's whole step.
  const timeAt = (offset: number) => {
    const first = chart.buckets[0] ?? 0;
    if (stacked) return first + ((offset - left) / (band || 1)) * chart.stepMs;
    return first + ((offset - left) / (width || 1)) * spanMs;
  };

  useEffect(() => {
    if (!drag || !onZoom) return;
    const finish = () => {
      setDrag(null);
      if (Math.abs(drag.current - drag.start) < minimumDragPixels) return;
      const since = timeAt(Math.min(drag.start, drag.current));
      const until = timeAt(Math.max(drag.start, drag.current));
      onZoom(Math.round(since), Math.round(until));
    };
    window.addEventListener("mouseup", finish);
    return () => window.removeEventListener("mouseup", finish);
  });

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

  const legend = showLegend && !hiddenSeries && chart.series.length > 0 ? (
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
            className={onZoom && count > 1 ? "timeseriesChart__svg--zoomable" : undefined}
            height={size.height}
            onMouseDown={(event) => {
              if (!onZoom || count < 2 || event.button !== 0) return;
              event.preventDefault();
              const offset = plotOffset(event);
              setDrag({ current: offset, start: offset });
            }}
            onMouseLeave={() => setHover(null)}
            onMouseMove={onMove}
            role="img"
            width={size.width}
          >
            {/* Opaque surface tints keep overlapping series from mixing into grey. */}
            {!stacked ? (
              <>
                <defs>
                  {Array.from({ length: seriesColors }, (_, color) => (
                    <linearGradient
                      className={`timeseriesChart__color--${color}`}
                      id={`${gradientId}-${color}`}
                      key={color}
                      x1="0" x2="0" y1="0" y2="1"
                    >
                      <stop offset="0%" stopColor="color-mix(in srgb, var(--series) 16%, var(--ds-surface-overlay))" />
                      <stop offset="100%" stopColor="color-mix(in srgb, var(--series) 5%, var(--ds-surface-overlay))" />
                    </linearGradient>
                  ))}
                </defs>
                {visible.map((series) => {
                  const first = series.values.findIndex((value) => value !== null);
                  const last = series.values.findLastIndex((value) => value !== null);
                  if (first < 0 || first === last) return null;
                  return (
                    <path
                      d={`${linePath(series.values)}L${x(last).toFixed(1)},${(plotTop + height).toFixed(1)}L${x(first).toFixed(1)},${(plotTop + height).toFixed(1)}Z`}
                      fill={`url(#${gradientId}-${colorOf.get(series.name)})`}
                      key={series.name}
                      pointerEvents="none"
                    />
                  );
                })}
              </>
            ) : null}
            {spanMs > 0 ? highlights.map((region, index) => {
              const first = chart.buckets[0]!;
              const from = Math.max(0, Math.min(1, (region.start - first) / spanMs));
              const to = Math.max(0, Math.min(1, (region.end - first) / spanMs));
              return to > from ? <rect key={index} x={left + from * width} y={plotTop} width={(to - from) * width} height={height} fill="#4e58f914"><title>{region.label}</title></rect> : null;
            }) : null}
            {ticks.map((tick) => (
              <g key={tick}>
                <line className="timeseriesChart__grid" x1={left} x2={left + width} y1={y(tick)} y2={y(tick)} />
              </g>
            ))}
            {showXAxis
              ? chart.buckets.map((time, index) =>
                  index % labelEvery === 0 ? (
                    <text
                      className="timeseriesChart__axis"
                      key={time}
                      textAnchor={index === 0 ? "start" : index === count - 1 ? "end" : "middle"}
                      x={x(index)}
                      y={plotTop + height + 15}
                    >
                      {timeLabel(time, spanMs, timeZone)}
                    </text>
                  ) : null,
                )
              : null}
            {hover !== null ? (
              stacked ? (
                <rect className="timeseriesChart__hover" height={height} width={band} x={left + hover * band} y={plotTop} />
              ) : (
                <line className="timeseriesChart__cursor" x1={x(hover)} x2={x(hover)} y1={plotTop} y2={plotTop + height} />
              )
            ) : null}
            {stacked
              ? columns.map((segments, index) =>
                  segments.map((segment) => (
                    <rect
                      className={`timeseriesChart__bar timeseriesChart__color--${colorOf.get(segment.name)}`}
                      height={Math.max(0.5, Math.abs(y(segment.from) - y(segment.to)))}
                      key={`${index}-${segment.name}`}
                      width={barWidth}
                      rx={density === "compact" ? 1 : 0}
                      x={x(index) - barWidth / 2}
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
            {drag && Math.abs(drag.current - drag.start) >= minimumDragPixels ? (
              <rect
                className="timeseriesChart__selection"
                height={height}
                width={Math.abs(drag.current - drag.start)}
                x={Math.min(drag.start, drag.current)}
                y={plotTop}
              />
            ) : null}
            {/* Drawn last, so bars crossing it do not hide it. */}
            {threshold !== undefined ? (
              <line className="timeseriesChart__threshold" x1={left} x2={left + width} y1={y(threshold)} y2={y(threshold)} />
            ) : null}
            {showYAxis ? ticks.map((tick, index) => (
              <text className="timeseriesChart__axis timeseriesChart__axis--y" key={tick} textAnchor="end" x={left - 8} y={y(tick) + 4}>
                {axisLabels[index]}
              </text>
            )) : null}
          </svg>
        ) : null}
        {hover !== null && hoverRows.length > 0 && !drag ? (
          <div className="timeseriesChart__tooltip" ref={tooltipRef} style={{ transform: `translateX(${tooltipLeft}px)` }}>
            <time>{new Date(chart.buckets[hover]!).toLocaleString(undefined, { ...(timeZone ? { timeZone } : {}), day: "numeric", hour: "2-digit", hour12: false, minute: "2-digit", month: "short", second: chart.stepMs < 60_000 ? "2-digit" : undefined })}</time>
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
