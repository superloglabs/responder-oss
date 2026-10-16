import { WarningCircleIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, DataTable, Switch } from "../design-system";
import {
  fetchTrace,
  formatDuration,
  formatExplorerTime,
  formatTelemetryTime,
  levelLabel,
  logExplorerParams,
  logTimestamp,
  severityTextTone,
  spanKindLabel,
  spanWaterfall,
  traceHref,
  type ExplorerFilter,
  type Span,
  type TraceDetail,
  type TraceListState,
} from "../telemetry-api";
import { useTelemetryQuery } from "../use-telemetry-query";
import { AttributeTable, ExplorerDrawer } from "./telemetry-explorer";
import { TraceWaterfall } from "./trace-waterfall";

type TraceLog = TraceDetail["logs"][number];
type TraceTab = "logs" | "services" | "waterfall";

const errorStatus = "STATUS_CODE_ERROR";

// Where a span starts, after the trace's first span.
function startOffsetMs(span: Span, traceStart: bigint): number {
  return Number(BigInt(span.start_ns) - traceStart) / 1_000_000;
}

function SpanPanel({
  logs,
  onFilter,
  span,
  traceStart,
}: {
  logs: TraceLog[];
  onFilter?: (filter: ExplorerFilter) => void;
  span: Span;
  traceStart: bigint;
}) {
  const failure = [span.exception_type, span.exception_message || span.status_message].filter(Boolean).join(": ");
  const logsHref = `/logs?${logExplorerParams({
    facets: [],
    filters: [
      { key: "field.trace_id", op: "eq", value: span.trace_id },
      { key: "field.span_id", op: "eq", value: span.span_id },
    ],
    range: "7d",
    search: "",
    services: [],
    severities: [],
  })}`;
  return (
    <section aria-label="Span details" className="traceDrawer__span">
      <header className="traceDrawer__spanHeader">
        <strong>Span</strong>
        <span className="traceDrawer__spanName">{span.span_name}</span>
        <span className="explorerCell--muted">
          {spanKindLabel(span.span_kind).toLowerCase()} · {formatDuration(span.duration_ms)} · started +{formatDuration(startOffsetMs(span, traceStart))}
        </span>
        <span className="explorerDrawer__spacer" />
        <span className="explorerCell--muted">span {span.span_id}</span>
      </header>
      {span.status_code === errorStatus ? (
        <p className="traceDrawer__error" role="status">
          <WarningCircleIcon aria-hidden="true" size={14} />
          {failure || "This span reported an error."}
        </p>
      ) : null}
      {span.exception_stacktrace ? <pre className="explorerBlock">{span.exception_stacktrace}</pre> : null}
      <div className="traceDrawer__spanBody">
        <AttributeTable
          onFilter={onFilter ? (key, op, value) => onFilter({ key, op, value }) : undefined}
          scopes={[
            { label: "Span", prefix: "span.", values: span.span_attrs },
            { label: "Resource", prefix: "resource.", values: span.resource_attrs },
          ]}
        />
        <section className="explorerTable traceDrawer__logs">
          <header className="explorerTable__header">
            <span>Logs in this span</span>
            <Link to={logsHref}>Open in Logs</Link>
          </header>
          <ul className="explorerTable__body">
            {logs.length === 0 ? <li className="explorerTable__empty">No logs from this span.</li> : null}
            {logs.map((log, index) => (
              <li key={`${log.ts_ns}-${index}`}>
                <span className="traceDrawer__logMeta">
                  <Badge tone={severityTextTone(log.severity)}>{levelLabel(log.severity)}</Badge>
                  <span className="explorerCell--muted">+{formatDuration(Number(BigInt(log.ts_ns) - traceStart) / 1_000_000)}</span>
                </span>
                <span className="traceDrawer__logBody">{log.body}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </section>
  );
}

// A trace in a drawer over the trace list: its waterfall, the selected span,
// its logs and the services it crossed.
export function TraceDrawer({
  listState,
  onClose,
  onFilter,
  traceId,
}: {
  listState: TraceListState;
  onClose: () => void;
  // Adds a filter on a span attribute to the trace list.
  onFilter?: (filter: ExplorerFilter) => void;
  traceId: string;
}) {
  const trace = useTelemetryQuery(traceId, () => fetchTrace(traceId));
  const [tab, setTab] = useState<TraceTab>("waterfall");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const waterfall = useMemo(() => spanWaterfall(trace.data?.spans ?? []), [trace.data]);
  const spans = useMemo(() => trace.data?.spans ?? [], [trace.data]);
  const root = waterfall.rows[0]?.span;
  const errors = spans.filter((span) => span.status_code === errorStatus);
  // Open on the first failing span, or the root.
  const selectedId = chosen ?? waterfall.rows.find((row) => row.span.status_code === errorStatus)?.span.span_id ?? root?.span_id ?? null;
  const selected = spans.find((span) => span.span_id === selectedId) ?? null;
  const traceStart = waterfall.rows.reduce(
    (min, row) => (BigInt(row.span.start_ns) < min ? BigInt(row.span.start_ns) : min),
    root ? BigInt(root.start_ns) : 0n,
  );
  const services = useMemo(() => {
    const byService = new Map<string, { durationMs: number; errors: number; spans: number }>();
    for (const span of spans) {
      const entry = byService.get(span.service) ?? { durationMs: 0, errors: 0, spans: 0 };
      entry.spans += 1;
      entry.durationMs += span.duration_ms;
      if (span.status_code === errorStatus) entry.errors += 1;
      byService.set(span.service, entry);
    }
    return [...byService].map(([name, entry]) => ({ name, ...entry })).sort((a, b) => b.spans - a.spans);
  }, [spans]);
  const rows = errorsOnly
    ? waterfall.rows.filter((row) => row.span.status_code === errorStatus)
    : waterfall.rows;

  function openSpan(spanId: string) {
    setTab("waterfall");
    setErrorsOnly(false);
    setChosen(spanId);
  }

  return (
    <ExplorerDrawer
      header={(
        <>
          {errors.length > 0 ? <Badge tone="danger">{errors.length} {errors.length === 1 ? "error" : "errors"}</Badge> : null}
          <strong className="traceDrawer__title">{root?.span_name ?? "Trace"}</strong>
          <span className="explorerDrawer__spacer" />
          <Link className="dsButton dsButton--secondary dsButton--small" state={listState} to={traceHref(traceId)}>
            Open full page
          </Link>
        </>
      )}
      label="Trace details"
      onClose={onClose}
      wide
    >
      {trace.error ? (
        <div className="automationRuns__message" role="alert">
          <p>{trace.error}</p>
          <button onClick={trace.retry} type="button">Retry</button>
        </div>
      ) : !trace.data || !root ? (
        <p className="explorerStatus">Loading trace…</p>
      ) : (
        <>
          <p className="traceDrawer__meta">
            <span>{root.service || "—"}</span>
            <time dateTime={logTimestamp(root.timestamp)?.toISOString()}>{formatTelemetryTime(root.timestamp)}</time>
            <span>{formatDuration(waterfall.durationMs)}</span>
            <span>{spans.length.toLocaleString()} {spans.length === 1 ? "span" : "spans"}</span>
            <span>{services.length} {services.length === 1 ? "service" : "services"}</span>
            <code>{traceId}</code>
          </p>
          <div className="traceDrawer__tabs">
            <div aria-label="Trace view" className="explorerPills" role="group">
              {([
                ["waterfall", "Waterfall", null],
                ["logs", "Logs", trace.data.logs.length],
                ["services", "Services", services.length],
              ] as const).map(([value, label, count]) => (
                <button aria-pressed={tab === value} key={value} onClick={() => setTab(value)} type="button">
                  {label}{count === null ? null : <span>{count}</span>}
                </button>
              ))}
            </div>
            {tab === "waterfall" && errors.length > 0 ? (
              <Switch checked={errorsOnly} className="traceDrawer__errorsOnly" label="Show only errors" onCheckedChange={setErrorsOnly} />
            ) : null}
          </div>
          {tab === "waterfall" ? (
            <>
              <TraceWaterfall durationMs={waterfall.durationMs} onSelect={setChosen} rows={rows} selected={selectedId} />
              {selected ? (
                <SpanPanel
                  logs={trace.data.logs.filter((log) => log.span_id === selected.span_id)}
                  onFilter={onFilter}
                  span={selected}
                  traceStart={traceStart}
                />
              ) : null}
            </>
          ) : null}
          {tab === "logs" ? (
            <div className="agentListTable explorerTableWrap">
              <DataTable<TraceLog & { key: string }>
                aria-label="Logs in this trace"
                columns={[
                  {
                    header: "Time",
                    key: "time",
                    render: (log) => <span className="explorerCell--muted">{formatExplorerTime(log.timestamp, false)}</span>,
                    width: "124px",
                  },
                  {
                    header: "Level",
                    key: "level",
                    render: (log) => <Badge tone={severityTextTone(log.severity)}>{levelLabel(log.severity)}</Badge>,
                    width: "76px",
                  },
                  {
                    header: "Service",
                    key: "service",
                    render: (log) => <span className="explorerCell--muted" title={log.service || undefined}>{log.service || "—"}</span>,
                    width: "128px",
                  },
                  {
                    header: "Message",
                    key: "message",
                    // Opens the span that wrote the log, when the trace has it.
                    render: (log) => spans.some((span) => span.span_id === log.span_id) ? (
                      <button className="explorerCell--message" onClick={() => openSpan(log.span_id)} title={log.body} type="button">
                        {log.body}
                      </button>
                    ) : (
                      <span className="explorerCell--message" title={log.body}>{log.body}</span>
                    ),
                  },
                ]}
                emptyMessage="No logs in this trace."
                getRowKey={(log) => log.key}
                rows={trace.data.logs.map((log, index) => ({ ...log, key: `${log.ts_ns}-${index}` }))}
                variant="workspace"
              />
            </div>
          ) : null}
          {tab === "services" ? (
            <div className="agentListTable explorerTableWrap">
              <DataTable<(typeof services)[number]>
                aria-label="Services in this trace"
                columns={[
                  { header: "Service", key: "name", render: (row) => row.name || "—" },
                  { align: "right", header: "Spans", key: "spans", render: (row) => <span className="explorerCell--number">{row.spans}</span>, width: "96px" },
                  {
                    align: "right",
                    header: "Errors",
                    key: "errors",
                    render: (row) => <span className={row.errors ? "explorerCell--number traceDrawer__errorCount" : "explorerCell--number"}>{row.errors}</span>,
                    width: "96px",
                  },
                  {
                    align: "right",
                    header: "Time in spans",
                    key: "duration",
                    render: (row) => <span className="explorerCell--number">{formatDuration(row.durationMs)}</span>,
                    width: "136px",
                  },
                ]}
                getRowKey={(row) => row.name}
                rows={services}
                variant="workspace"
              />
            </div>
          ) : null}
        </>
      )}
    </ExplorerDrawer>
  );
}
