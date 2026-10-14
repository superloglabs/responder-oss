import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AppShell } from "../components/app-shell";
import { SendTelemetryLink, TelemetryAttributes, TelemetryException, TelemetryProjectsGate } from "../components/telemetry";
import { Badge, DataTable, IconButton, SegmentedControl, SelectField } from "../design-system";
import {
  fetchLogs,
  fetchServices,
  formatTelemetryTime,
  logTimestamp,
  severityTone,
  telemetryRanges,
  traceHref,
  type LogRecord,
  type TelemetryRange,
} from "../telemetry-api";
import { useTelemetryProjects } from "../use-telemetry-projects";
import { useDocumentTitle } from "../use-document-title";
import "../components/automation-run-history.css";

const severities = [
  { label: "All severities", value: "" },
  { label: "Fatal", value: "FATAL" },
  { label: "Error", value: "ERROR" },
  { label: "Warn", value: "WARN" },
  { label: "Info", value: "INFO" },
  { label: "Debug", value: "DEBUG" },
  { label: "Trace", value: "TRACE" },
];

function logKey(log: LogRecord, index: number): string {
  return `${log.timestamp}-${log.span_id}-${index}`;
}

function LogDetail({ log, onClose, projectId }: { log: LogRecord; onClose: () => void; projectId: string }) {
  return (
    <aside aria-label="Log details" className="telemetryDetail">
      <header className="telemetryDetail__header">
        <Badge tone={severityTone(log.severity_number)}>{log.severity || "Unset"}</Badge>
        <span>{formatTelemetryTime(log.timestamp)}</span>
        <IconButton aria-label="Close log details" onClick={onClose}>
          <XIcon size={14} />
        </IconButton>
      </header>
      <pre className="telemetryDetail__body">{log.body}</pre>
      <TelemetryException
        message={log.exception_message}
        stacktrace={log.exception_stacktrace}
        type={log.exception_type}
      />
      <dl className="telemetryDetail__attributes">
        <div><dt>Service</dt><dd>{log.service || "—"}</dd></div>
        {log.trace_id ? (
          <div><dt>Trace ID</dt><dd><Link to={traceHref(projectId, log.trace_id)}>{log.trace_id}</Link></dd></div>
        ) : null}
        {log.span_id ? <div><dt>Span ID</dt><dd>{log.span_id}</dd></div> : null}
      </dl>
      <TelemetryAttributes title="Log attributes" values={log.log_attrs} />
      <TelemetryAttributes title="Resource attributes" values={log.resource_attrs} />
    </aside>
  );
}

export function LogsPage() {
  useDocumentTitle("Logs");
  const telemetry = useTelemetryProjects();
  const [chosenProjectId, setProjectId] = useState("");
  const projectId = chosenProjectId || telemetry.projects?.[0]?.projectId || "";
  const [range, setRange] = useState<TelemetryRange>("1h");
  const [service, setService] = useState("");
  const [severity, setSeverity] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [services, setServices] = useState<string[]>([]);
  const [logs, setLogs] = useState<LogRecord[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    fetchServices(projectId, range)
      .then((loaded) => { if (!cancelled) setServices(loaded); })
      .catch(() => { if (!cancelled) setServices([]); });
    return () => { cancelled = true; };
  }, [projectId, range]);

  const load = useCallback(async () => {
    if (!projectId) return;
    const generation = ++request.current;
    setLogs(null);
    setSelected(null);
    try {
      const loaded = await fetchLogs({ projectId, range, search, service, severity });
      if (request.current !== generation) return;
      setLogs(loaded);
      setError(null);
    } catch (cause) {
      if (request.current !== generation) return;
      setLogs([]);
      setError(cause instanceof Error ? cause.message : "Unable to load logs");
    }
  }, [projectId, range, search, service, severity]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => { request.current += 1; };
  }, [load]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setSearch(searchInput.trim());
  }

  const selectedLog = logs?.find((log, index) => logKey(log, index) === selected) ?? null;
  const serviceOptions = [
    { label: "All services", value: "" },
    // Keep a chosen service listed after it leaves the window.
    ...[...new Set([...services, ...(service ? [service] : [])])]
      .sort()
      .map((name) => ({ label: name, value: name })),
  ];

  return (
    <AppShell active="logs" redesigned>
      <header className="workspaceHeading">
        <h1><MagnifyingGlassIcon aria-hidden="true" size={16} weight="bold" />Logs</h1>
        <div className="workspaceHeading__actions">
          <SendTelemetryLink variant="secondary" />
        </div>
      </header>
      <TelemetryProjectsGate signal="Logs" state={telemetry}>
        {(projects) => (
          <section aria-label="Logs" className="telemetryPage">
            <div className="telemetryPage__toolbar">
              {projects.length > 1 ? (
                <SelectField
                  className="telemetryPage__select"
                  label="Project"
                  onChange={(value) => {
                    setProjectId(value);
                    setService("");
                  }}
                  options={projects.map((project) => ({ label: project.name, value: project.projectId }))}
                  value={projectId}
                />
              ) : null}
              <SelectField
                className="telemetryPage__select"
                label="Service"
                onChange={setService}
                options={serviceOptions}
                searchable={serviceOptions.length > 8}
                value={service}
              />
              <SelectField
                className="telemetryPage__select"
                label="Severity"
                onChange={setSeverity}
                options={severities}
                value={severity}
              />
              <form className="telemetryPage__search" onSubmit={submitSearch} role="search">
                <MagnifyingGlassIcon aria-hidden="true" size={14} />
                <input
                  aria-label="Search log messages"
                  maxLength={200}
                  onBlur={() => setSearch(searchInput.trim())}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="Search messages"
                  type="search"
                  value={searchInput}
                />
              </form>
              <SegmentedControl aria-label="Time range" onChange={setRange} options={telemetryRanges} value={range} />
            </div>
            {error ? (
              <div className="automationRuns__message" role="alert">
                <p>{error}</p>
                <button onClick={() => void load()} type="button">Retry</button>
              </div>
            ) : null}
            <div className={selectedLog ? "telemetryPage__body telemetryPage__body--detail" : "telemetryPage__body"}>
              <div className="agentListTable telemetryPage__table">
                {logs === null ? (
                  <p className="telemetryPage__status">Loading logs…</p>
                ) : (
                  <DataTable<LogRecord & { key: string }>
                    aria-label="Log records"
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
                        render: (log) => <Badge tone={severityTone(log.severity_number)}>{log.severity || "Unset"}</Badge>,
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
                        // A button, so the details open from the keyboard too.
                        render: (log) => (
                          <button
                            aria-expanded={log.key === selected}
                            className="telemetryPage__message"
                            onClick={() => setSelected(log.key === selected ? null : log.key)}
                            type="button"
                          >
                            {log.body}
                          </button>
                        ),
                      },
                    ]}
                    emptyMessage="No logs match these filters in this time range."
                    getRowKey={(log) => log.key}
                    onRowClick={(log) => setSelected(log.key === selected ? null : log.key)}
                    rows={logs.map((log, index) => ({ ...log, key: logKey(log, index) }))}
                    variant="workspace"
                  />
                )}
              </div>
              {selectedLog ? <LogDetail log={selectedLog} onClose={() => setSelected(null)} projectId={projectId} /> : null}
            </div>
          </section>
        )}
      </TelemetryProjectsGate>
    </AppShell>
  );
}
