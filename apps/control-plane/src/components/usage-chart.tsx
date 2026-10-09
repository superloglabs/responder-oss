import { useState, type KeyboardEvent } from "react";
import {
  formatUsage,
  formatUsageTick,
  usageAxisTicks,
  usageDayLabel,
  type UsageChart as UsageChartData,
  type UsageMetric,
} from "../usage-history-presentation";
import "./usage-chart.css";

// How many day labels the x-axis shows at most.
const maximumDayLabels = 6;

function dayLabelIndexes(count: number): Set<number> {
  if (count <= maximumDayLabels) return new Set(Array.from({ length: count }, (_, index) => index));
  const step = Math.ceil((count - 1) / (maximumDayLabels - 1));
  const indexes = new Set<number>();
  // Count back from the last day so today is always labeled.
  for (let index = count - 1; index >= 0; index -= step) indexes.add(index);
  return indexes;
}

// Daily stacked columns, one segment per series. The legend lists each
// series and its total, which doubles as the table view. It is shown for
// more than one series unless `legend` says otherwise.
export function UsageChart({
  chart,
  label,
  legend,
  metric,
}: {
  chart: UsageChartData;
  // Names the chart for assistive technology.
  label: string;
  legend?: boolean;
  metric: UsageMetric;
}) {
  const [active, setActive] = useState<number | null>(null);
  const ticks = usageAxisTicks(Math.max(0, ...chart.columns.map((column) => column.total)));
  const top = ticks[ticks.length - 1] || 1;
  const slots = new Map(chart.series.map((series) => [series.key, series]));
  const labeled = dayLabelIndexes(chart.columns.length);
  const activeColumn = active === null ? null : chart.columns[active];
  const multiple = (legend ?? chart.series.length > 1) && chart.series.length > 0;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const last = chart.columns.length - 1;
    const next =
      event.key === "ArrowLeft" ? Math.max(0, (active ?? last + 1) - 1)
        : event.key === "ArrowRight" ? Math.min(last, (active ?? -1) + 1)
          : event.key === "Home" ? 0
            : event.key === "End" ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  }

  return (
    <figure className="usageChart">
      <div className="usageChart__frame">
        <div aria-hidden="true" className="usageChart__ticks">
          {ticks.map((tick) => (
            <span key={tick} style={{ bottom: `${(tick / top) * 100}%` }}>
              {formatUsageTick(metric, tick)}
            </span>
          ))}
        </div>
        <div
          aria-label={`${label}. ${formatUsage(metric, chart.total)} in total. Use the arrow keys to read each day.`}
          className="usageChart__plot"
          onBlur={() => setActive(null)}
          onKeyDown={onKeyDown}
          onMouseLeave={() => setActive(null)}
          role="group"
          tabIndex={0}
        >
          {ticks.map((tick) => (
            <span
              aria-hidden="true"
              className="usageChart__grid"
              key={tick}
              style={{ bottom: `${(tick / top) * 100}%` }}
            />
          ))}
          {chart.columns.map((column, index) => (
            <div
              aria-hidden="true"
              className="usageChart__column"
              data-active={active === index || undefined}
              key={column.day}
              onMouseEnter={() => setActive(index)}
            >
              {column.total > 0 ? (
                <div
                  className="usageChart__stack"
                  style={{ height: `${(column.total / top) * 100}%` }}
                >
                  {column.segments.map((segment) => (
                    <span
                      className="usageChart__segment"
                      data-slot={slots.get(segment.series)?.slot ?? 8}
                      key={segment.series}
                      style={{ flexGrow: segment.value }}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ))}
          {activeColumn && active !== null ? (
            <div
              className="usageChart__tooltip"
              data-side={active > chart.columns.length / 2 ? "left" : "right"}
              role="status"
              style={{ left: `${((active + 0.5) / chart.columns.length) * 100}%` }}
            >
              <div className="usageChart__tooltipTotal">
                <span>{usageDayLabel(activeColumn.day, { day: "numeric", month: "long", weekday: "short" })}</span>
                <strong>{formatUsage(metric, activeColumn.total)}</strong>
              </div>
              {multiple && activeColumn.segments.length ? (
                <ul>
                  {[...activeColumn.segments].reverse().map((segment) => {
                    const series = slots.get(segment.series);
                    return (
                      <li key={segment.series}>
                        <i aria-hidden="true" data-slot={series?.slot ?? 8} />
                        <span>{series?.label ?? "Other"}</span>
                        <strong>{formatUsage(metric, segment.value)}</strong>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
        <div aria-hidden="true" className="usageChart__days">
          {chart.columns.map((column, index) => (
            <span
              data-edge={index === 0 ? "start" : index === chart.columns.length - 1 ? "end" : undefined}
              key={column.day}
            >
              {labeled.has(index) ? usageDayLabel(column.day) : ""}
            </span>
          ))}
        </div>
      </div>
      {multiple ? (
        <figcaption>
          <ul className="usageChart__legend">
            {/* A source with none of this metric keeps its color slot but is not listed. */}
            {chart.series.filter((series) => series.total > 0).map((series) => (
              <li key={series.key}>
                <i aria-hidden="true" data-slot={series.slot} />
                <span>{series.label}</span>
                <strong>{formatUsage(metric, series.total)}</strong>
              </li>
            ))}
          </ul>
        </figcaption>
      ) : null}
    </figure>
  );
}
