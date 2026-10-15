import { XIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { AppShell } from "../components/app-shell";
import { TelemetryAttributes, TelemetryException, TelemetryGate } from "../components/telemetry";
import { TraceWaterfall } from "../components/trace-waterfall";
import { Badge, DataTable, IconButton } from "../design-system";
import {
  fetchTrace,
  formatDuration,
  formatTelemetryTime,
  logTimestamp,
  severityTextTone,
  spanKindLabel,
  spanStatus,
  spanWaterfall,
  traceListHref,
  type Span,
  type TraceDetail,
} from "../telemetry-api";
import { useTelemetryAvailable } from "../use-telemetry-available";
import { useDocumentTitle } from "../use-document-title";
import "../components/automation-run-history.css";
import "./automation-create.css";

type TraceLog = TraceDetail["logs"][number];

function SpanDetail({ logs, onClose, span }: { logs: TraceLog[]; onClose: () => void; span: Span }) {
  const status = spanStatus(span.status_code);
  return (
    <aside aria-label="Span details" className="telemetryDetail">
      <header className="telemetryDetail__header">
        <Badge tone={status.tone}>{status.label}</Badge>
        <span>{formatDuration(span.duration_ms)}</span>
        <IconButton aria-label="Close span details" onClick={onClose}>
          <XIcon size={14} />
        </IconButton>
      </header>
      <pre className="telemetryDetail__body">{span.span_name}</pre>
      {span.status_message ? <p className="telemetryDetail__exception">{span.status_message}</p> : null}
      <TelemetryException message={span.exception_message} stacktrace={span.exception_stacktrace} type={span.exception_type} />
      <dl className="telemetryDetail__attributes">
        <div><dt>Service</dt><dd>{span.service || "—"}</dd></div>
        <div><dt>Kind</dt><dd>{spanKindLabel(span.span_kind)}</dd></div>
        <div><dt>Started</dt><dd>{formatTelemetryTime(span.timestamp)}</dd></div>
        <div><dt>Span ID</dt><dd>{span.span_id}</dd></div>
        {span.parent_span_id ? <div><dt>Parent span ID</dt><dd>{span.parent_span_id}</dd></div> : null}
      </dl>
      {logs.length > 0 ? (
        <section className="telemetryDetail__section">
          <h3>Logs</h3>
          <ul className="traceDetail__spanLogs">
            {logs.map((log, index) => (
              <li key={`${log.ts_ns}-${index}`}>
                <Badge tone={severityTextTone(log.severity)}>{log.severity || "Unset"}</Badge>
                <span>{log.body}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <TelemetryAttributes title="Span attributes" values={span.span_attrs} />
      <TelemetryAttributes title="Resource attributes" values={span.resource_attrs} />
    </aside>
  );
}

function TraceView({ traceId }: { traceId: string }) {
  const location = useLocation();
  const [trace, setTrace] = useState<TraceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    const generation = ++request.current;
    setTrace(null);
    setError(null);
    setSelected(null);
    try {
      const loaded = await fetchTrace(traceId);
      if (request.current === generation) setTrace(loaded);
    } catch (cause) {
      if (request.current === generation) setError(cause instanceof Error ? cause.message : "Unable to load trace");
    }
  }, [traceId]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => { request.current += 1; };
  }, [load]);

  const { durationMs, rows } = useMemo(() => spanWaterfall(trace?.spans ?? []), [trace]);
  const root = rows[0]?.span;
  useDocumentTitle(root ? `${root.span_name} · Traces` : "Traces");

  // From a log further down the page, bring its span back into view.
  function openSpan(spanId: string) {
    setSelected(spanId);
    document.getElementById(`span-${spanId}`)?.scrollIntoView({ block: "nearest" });
  }

  if (error) {
    return (
      <div className="automationRuns__message" role="alert">
        <p>{error}</p>
        <button onClick={() => void load()} type="button">Retry</button>
      </div>
    );
  }
  if (!trace || !root) return <p className="telemetryPage__status">Loading trace…</p>;

  const services = new Set(trace.spans.map((span) => span.service).filter(Boolean));
  const errors = trace.spans.filter((span) => span.status_code === "STATUS_CODE_ERROR").length;
  const selectedSpan = trace.spans.find((span) => span.span_id === selected) ?? null;

  return (
    <>
      <header className="automationCreate__header">
        <nav aria-label="Breadcrumb" className="automationCreate__breadcrumb">
          <Link to={traceListHref(location.state)}>Traces</Link>
          <span aria-hidden="true">›</span>
          <span aria-current="page">{traceId.slice(0, 8)}</span>
        </nav>
        <div className="automationCreate__titleRow">
          <h1 className="traceDetail__title">{root.span_name}</h1>
        </div>
        <p className="traceDetail__meta">
          <span>{root.service || "—"}</span>
          <time dateTime={logTimestamp(root.timestamp)?.toISOString()}>{formatTelemetryTime(root.timestamp)}</time>
          <span>{formatDuration(durationMs)}</span>
          <span>{trace.spans.length.toLocaleString()} {trace.spans.length === 1 ? "span" : "spans"}</span>
          <span>{services.size} {services.size === 1 ? "service" : "services"}</span>
          {errors > 0 ? <Badge tone="danger">{errors} {errors === 1 ? "error" : "errors"}</Badge> : null}
          <code>{traceId}</code>
        </p>
      </header>
      <div className={selectedSpan ? "telemetryPage__body telemetryPage__body--detail" : "telemetryPage__body"}>
        <TraceWaterfall durationMs={durationMs} onSelect={setSelected} rows={rows} selected={selected} />
        {selectedSpan ? (
          <SpanDetail
            logs={trace.logs.filter((log) => log.span_id === selectedSpan.span_id)}
            onClose={() => setSelected(null)}
            span={selectedSpan}
          />
        ) : null}
      </div>
      {trace.logs.length > 0 ? (
        <section aria-label="Logs in this trace" className="telemetryPage">
          <h2 className="traceDetail__heading">Logs</h2>
          <div className="agentListTable telemetryPage__table">
            <DataTable<TraceLog & { key: string }>
              aria-label="Logs in this trace"
              columns={[
                {
                  header: "Time",
                  key: "time",
                  render: (log) => <time className="telemetryPage__time" dateTime={logTimestamp(log.timestamp)?.toISOString()}>{formatTelemetryTime(log.timestamp)}</time>,
                  width: "130px",
                },
                {
                  header: "Level",
                  key: "severity",
                  render: (log) => <Badge tone={severityTextTone(log.severity)}>{log.severity || "Unset"}</Badge>,
                  width: "88px",
                },
                {
                  header: "Service",
                  key: "service",
                  render: (log) => <span className="telemetryPage__service">{log.service || "—"}</span>,
                  width: "120px",
                },
                {
                  header: "Message",
                  key: "message",
                  // Opens the span that wrote the log, when the trace has it.
                  render: (log) => log.span_id && trace.spans.some((span) => span.span_id === log.span_id) ? (
                    <button className="telemetryPage__message" onClick={() => openSpan(log.span_id)} type="button">
                      {log.body}
                    </button>
                  ) : (
                    <span className="telemetryPage__message">{log.body}</span>
                  ),
                },
              ]}
              getRowKey={(log) => log.key}
              rows={trace.logs.map((log, index) => ({ ...log, key: `${log.ts_ns}-${index}` }))}
              variant="workspace"
            />
          </div>
        </section>
      ) : null}
    </>
  );
}

export function TraceDetailPage() {
  const telemetry = useTelemetryAvailable();
  const { traceId = "" } = useParams();
  return (
    <AppShell active="traces" activePage="/traces/search" redesigned>
      <div className="automationCreate traceDetail">
        <TelemetryGate signal="Traces" state={telemetry}>
          <TraceView traceId={traceId} />
        </TelemetryGate>
      </div>
    </AppShell>
  );
}
