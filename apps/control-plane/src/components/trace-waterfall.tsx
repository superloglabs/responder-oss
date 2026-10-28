import { CaretDownIcon, MagnifyingGlassIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { type CSSProperties, useMemo, useState } from "react";
import { formatDuration, type WaterfallRow } from "../telemetry-api";
import { traceServiceColors, visibleTraceRows } from "./trace-view-model";

const ticks = [0, 25, 50, 75, 100];

export function TraceWaterfall({ durationMs, errorsOnly = false, onSelect, rows, selected }: {
  durationMs: number;
  errorsOnly?: boolean;
  onSelect: (spanId: string | null) => void;
  rows: WaterfallRow[];
  selected: string | null;
}) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const colors = useMemo(() => traceServiceColors(rows), [rows]);
  const parents = useMemo(() => new Set(rows.filter((row, index) => (rows[index + 1]?.depth ?? 0) > row.depth).map(({ span }) => span.span_id)), [rows]);
  const visible = useMemo(() => visibleTraceRows(rows, collapsed, search, errorsOnly), [rows, collapsed, search, errorsOnly]);
  const filtering = Boolean(search.trim()) || errorsOnly;
  return (
    <section aria-label="Spans" className="traceWaterfallView">
      <div className="traceWaterfallView__toolbar">
        <label className="traceWaterfallView__search">
          <MagnifyingGlassIcon aria-hidden="true" size={12} />
          <input aria-label="Find a span or attribute" onChange={(event) => setSearch(event.target.value)} placeholder="Find a span or attribute" type="search" value={search} />
        </label>
        <ul aria-label="Services" className="traceWaterfallView__legend">
          {[...colors].map(([service, color]) => <li key={service}><i aria-hidden="true" style={{ backgroundColor: color }} /><span title={service}>{service || "Unknown service"}</span></li>)}
        </ul>
        <button className="traceWaterfallView__toggle" disabled={!parents.size || filtering} onClick={() => setCollapsed(collapsed.size ? new Set() : new Set(parents))} type="button">{collapsed.size ? "Expand all" : "Collapse all"}</button>
      </div>
      <div className="traceWaterfall">
        <div aria-hidden="true" className="traceWaterfall__axis">
          <span className="traceWaterfall__name">Span</span>
          <span className="traceWaterfall__track">{ticks.map((tick) => <span key={tick} style={{ left: `${tick}%` }}>{tick === 0 ? "0" : formatDuration(durationMs * tick / 100)}</span>)}</span>
          <span className="traceWaterfall__duration">Duration</span>
        </div>
        <ul className="traceWaterfall__rows">
          {!visible.length ? <li className="traceWaterfall__empty">No spans match.</li> : null}
          {visible.map((row) => {
            const { span } = row;
            const isError = span.status_code === "STATUS_CODE_ERROR";
            const isSelected = span.span_id === selected;
            const expanded = filtering || !collapsed.has(span.span_id);
            return (
              <li className={`traceWaterfall__row${isSelected ? " traceWaterfall__row--selected" : ""}${isError ? " traceWaterfall__row--error" : ""}`} id={`span-${span.span_id}`} key={span.span_id} style={{ "--trace-service-color": colors.get(span.service) } as CSSProperties}>
                <div className="traceWaterfall__name" style={{ paddingLeft: `${12 + Math.min(row.depth, 12) * 14}px` }}>
                  <span className="traceWaterfall__disclosure">
                    {parents.has(span.span_id) ? <button aria-label={`${expanded ? "Collapse" : "Expand"} ${span.span_name}`} aria-expanded={expanded} disabled={filtering} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(span.span_id)) next.delete(span.span_id); else next.add(span.span_id); return next; })} type="button"><CaretDownIcon aria-hidden="true" size={12} /></button> : null}
                  </span>
                  <button aria-pressed={isSelected} className="traceWaterfall__select" onClick={() => onSelect(isSelected ? null : span.span_id)} title={`${span.service || "Unknown service"} · ${span.span_name}`} type="button">
                    <i aria-hidden="true" className="traceWaterfall__service" />
                    <span className="traceWaterfall__spanName">{span.span_name}</span>
                    {isError ? <WarningCircleIcon aria-label="Error" size={13} /> : null}
                  </button>
                </div>
                <button aria-label={`Inspect ${span.span_name}, ${formatDuration(span.duration_ms)}`} aria-pressed={isSelected} className="traceWaterfall__track" onClick={() => onSelect(isSelected ? null : span.span_id)} type="button"><span className="traceWaterfall__bar" style={{ left: `${row.offset}%`, width: `${row.width}%` }} /></button>
                <span className="traceWaterfall__duration">{formatDuration(span.duration_ms)}</span>
              </li>
            );
          })}
        </ul>
      </div>
      <div aria-live="polite" className="traceWaterfallView__footer"><span>{visible.length} of {rows.length} spans visible</span>{collapsed.size && !filtering ? <button onClick={() => setCollapsed(new Set())} type="button">Expand all</button> : null}</div>
    </section>
  );
}
