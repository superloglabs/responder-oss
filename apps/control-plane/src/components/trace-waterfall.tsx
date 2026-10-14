import { formatDuration, type WaterfallRow } from "../telemetry-api";

// Marks at each quarter of the trace's duration.
const ticks = [0, 25, 50, 75, 100];

// A trace's spans as a tree, each on the trace's timeline. Selecting a row
// shows that span's details.
export function TraceWaterfall({
  durationMs,
  onSelect,
  rows,
  selected,
}: {
  durationMs: number;
  onSelect: (spanId: string | null) => void;
  rows: WaterfallRow[];
  selected: string | null;
}) {
  return (
    <section aria-label="Spans" className="traceWaterfall">
      <div aria-hidden="true" className="traceWaterfall__axis">
        <span className="traceWaterfall__name">Span</span>
        <span className="traceWaterfall__track">
          {ticks.map((tick) => (
            <span key={tick} style={{ left: `${tick}%` }}>{tick === 0 ? "0" : formatDuration((durationMs * tick) / 100)}</span>
          ))}
        </span>
        <span />
      </div>
      <ul className="traceWaterfall__rows">
        {rows.length === 0 ? <li className="traceWaterfall__empty">No spans match.</li> : null}
        {rows.map((row) => {
          const isError = row.span.status_code === "STATUS_CODE_ERROR";
          const isSelected = row.span.span_id === selected;
          return (
            <li id={`span-${row.span.span_id}`} key={row.span.span_id}>
              <button
                aria-pressed={isSelected}
                className={`traceWaterfall__row${isSelected ? " traceWaterfall__row--selected" : ""}${isError ? " traceWaterfall__row--error" : ""}`}
                onClick={() => onSelect(isSelected ? null : row.span.span_id)}
                type="button"
              >
                <span className="traceWaterfall__name" style={{ paddingLeft: `${Math.min(row.depth, 12) * 14}px` }}>
                  <span className="traceWaterfall__service">{row.span.service}</span>
                  <span className="traceWaterfall__spanName">{row.span.span_name}</span>
                  {isError ? <span className="traceWaterfall__srOnly">, error</span> : null}
                </span>
                <span className="traceWaterfall__track">
                  <span className="traceWaterfall__bar" style={{ left: `${row.offset}%`, width: `${row.width}%` }} />
                </span>
                <span className="traceWaterfall__duration">{formatDuration(row.span.duration_ms)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
