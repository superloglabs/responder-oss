import { CaretUpIcon, CaretDownIcon, CopyIcon, XIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, DataTable, IconButton, Switch, Tabs } from "../design-system";
import {
  fetchTrace,
  formatDuration,
  formatExplorerTime,
  formatTelemetryTime,
  levelLabel,
  logExplorerParams,
  logMessage,
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
import { TraceDrawerSkeleton } from "./screen-skeletons";
import { AttributeTable, ExplorerDrawer } from "./telemetry-explorer";
import { copyText } from "../copy-to-clipboard";
import { traceAttributeScopes, traceRequest } from "./trace-view-model";
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
  onClose,
}: {
  logs: TraceLog[];
  onFilter?: (filter: ExplorerFilter) => void;
  span: Span;
  traceStart: bigint;
  onClose: () => void;
}) {
  const failure = [span.exception_type, span.exception_message || span.status_message].filter(Boolean).join(": ");
  const logsHref = `/logs?${logExplorerParams({
    facets: [],
    filters: [
      { key: "field.trace_id", op: "eq", value: span.trace_id },
      { key: "field.span_id", op: "eq", value: span.span_id },
    ],
    range: { kind: "relative", minutes: 10_080 },
    search: "",
    services: [],
    severities: [],
  })}`;
  return (
    <section aria-label="Span details" className="traceDrawer__span">
      <header className="traceDrawer__spanHeader">
        <div className="traceDrawer__spanHeading"><span>Selected span</span><IconButton aria-label="Close span details" onClick={onClose} size="small" variant="ghost"><XIcon size={14} /></IconButton></div>
        <h2 className="traceDrawer__spanName">{span.span_name}</h2>
        <p className="traceDrawer__meta"><span>{span.service || "Unknown service"}</span><span>{spanKindLabel(span.span_kind).toLowerCase()}</span><span>{formatDuration(span.duration_ms)}</span><span>started +{formatDuration(startOffsetMs(span, traceStart))}</span></p>
        <CopyId label="Span ID" value={span.span_id} />
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
          grouped
          scopes={traceAttributeScopes(span)}
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
                <span className="traceDrawer__logBody">{logMessage(log)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </section>
  );
}

function CopyId({ label, value }: { label: string; value: string }) {
  const [feedback, setFeedback] = useState("");
  return <div className="traceDrawer__id"><span>{label}</span><code>{value}</code><IconButton aria-label={`Copy ${label.toLowerCase()}`} size="small" variant="ghost" onClick={() => { void copyText(value).then(() => setFeedback("Copied"), () => setFeedback("Could not copy")); }}><CopyIcon size={12} /></IconButton><span role="status">{feedback}</span></div>;
}

// A trace in a drawer over the trace list: its waterfall, the selected span,
// its logs and the services it crossed.
export function TraceDrawer({
  listState,
  onClose,
  onFilter,
  traceId,
  onPrevious,
  onNext,
}: {
  listState: TraceListState;
  onClose: () => void;
  // Adds a filter on a span attribute to the trace list.
  onFilter?: (filter: ExplorerFilter) => void;
  traceId: string;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const trace = useTelemetryQuery(traceId, () => fetchTrace(traceId));
  const [tab, setTab] = useState<TraceTab>("waterfall");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const waterfall = useMemo(() => spanWaterfall(trace.data?.spans ?? []), [trace.data]);
  const spans = useMemo(() => trace.data?.spans ?? [], [trace.data]);
  const root = waterfall.rows[0]?.span;
  const errors = spans.filter((span) => span.status_code === errorStatus);
  // Open on the first failing span, or the root.
  const selectedId = chosen === undefined ? (waterfall.rows.find((row) => row.span.status_code === errorStatus)?.span.span_id ?? root?.span_id ?? null) : chosen;
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
  const request = root ? traceRequest(root) : null;

  function openSpan(spanId: string) {
    setTab("waterfall");
    setErrorsOnly(false);
    setChosen(spanId);
  }

  return (
    <ExplorerDrawer
      className="traceDrawer"
      fullHeight
      header={(
        <>
          <strong className="traceDrawer__title">Trace detail</strong>
          {root ? <time className="traceDrawer__timestamp" dateTime={logTimestamp(root.timestamp)?.toISOString()}>{formatTelemetryTime(root.timestamp)}</time> : null}
          <span className="explorerDrawer__spacer" />
          <Link className="dsButton dsButton--secondary dsButton--small" state={listState} to={traceHref(traceId)}>
            Open full page
          </Link>
          <IconButton aria-label="Previous trace" disabled={!onPrevious} onClick={onPrevious} size="small" variant="secondary"><CaretUpIcon size={14} /></IconButton>
          <IconButton aria-label="Next trace" disabled={!onNext} onClick={onNext} size="small" variant="secondary"><CaretDownIcon size={14} /></IconButton>
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
        <TraceDrawerSkeleton />
      ) : (
        <>
          <section className="traceDrawer__summary">
            <div className="traceDrawer__request">{request?.method && request.name !== request.method ? <Badge>{request.method}</Badge> : null}<h1>{request?.name}</h1>{request?.status ? <Badge tone={request.status >= 400 ? "danger" : "live"}>{request.status}</Badge> : null}</div>
            <p className="traceDrawer__meta"><span>{root.service || "Unknown service"}</span><span>{formatDuration(waterfall.durationMs)}</span><span>{spans.length.toLocaleString()} spans</span><span>{services.length} services</span><span className={errors.length ? "traceDrawer__errorCount" : undefined}>{errors.length} errors</span></p>
            <CopyId label="Trace ID" value={traceId} />
          </section>
          <div className="traceDrawer__tabs">
            <Tabs<TraceTab> aria-label="Trace view" onChange={setTab} value={tab} options={[{ value: "waterfall", label: `Waterfall ${spans.length}` }, { value: "logs", label: `Logs ${trace.data.logs.length}` }, { value: "services", label: `Services ${services.length}` }]} />
            {tab === "waterfall" && errors.length > 0 ? (
              <Switch checked={errorsOnly} className="traceDrawer__errorsOnly" label="Show only errors" onCheckedChange={setErrorsOnly} />
            ) : null}
          </div>
          {tab === "waterfall" ? (
            <div className={`traceDrawer__split${selected ? "" : " traceDrawer__split--closed"}`}>
              <TraceWaterfall durationMs={waterfall.durationMs} errorsOnly={errorsOnly} onSelect={setChosen} rows={waterfall.rows} selected={selectedId} />
              {selected ? (
                <SpanPanel
                  key={selected.span_id}
                  onClose={() => setChosen(null)}
                  logs={trace.data.logs.filter((log) => log.span_id === selected.span_id)}
                  onFilter={onFilter}
                  span={selected}
                  traceStart={traceStart}
                />
              ) : null}
            </div>
          ) : null}
          {tab === "logs" ? (
            <div className="agentListTable explorerTableWrap traceDrawer__tabContent">
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
                      <button className="explorerCell--message" onClick={() => openSpan(log.span_id)} title={logMessage(log)} type="button">
                        {logMessage(log)}
                      </button>
                    ) : (
                      <span className="explorerCell--message" title={logMessage(log)}>{logMessage(log)}</span>
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
            <div className="agentListTable explorerTableWrap traceDrawer__tabContent">
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
