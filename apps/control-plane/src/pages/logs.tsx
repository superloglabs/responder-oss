import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "../components/app-shell";
import { Badge, DataTable, IconButton, SegmentedControl, SelectField } from "../design-system";
import {
  fetchLogs,
  fetchServices,
  fetchTelemetryProjects,
  logTimestamp,
  severityTone,
  type LogRecord,
  type TelemetryProject,
  type TelemetryRange,
} from "../logs-api";
import { useDocumentTitle } from "../use-document-title";
import "../components/automation-run-history.css";
import "./logs.css";

const ranges: Array<{ label: string; value: TelemetryRange }> = [
  { label: "15m", value: "15m" },
  { label: "1h", value: "1h" },
  { label: "6h", value: "6h" },
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
];

const severities = [
  { label: "All severities", value: "" },
  { label: "Fatal", value: "FATAL" },
  { label: "Error", value: "ERROR" },
  { label: "Warn", value: "WARN" },
  { label: "Info", value: "INFO" },
  { label: "Debug", value: "DEBUG" },
  { label: "Trace", value: "TRACE" },
];

function formatTime(value: string): string {
  const date = logTimestamp(value);
  if (!date) return value;
  return date.toLocaleString(undefined, {
    day: "numeric",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    second: "2-digit",
  });
}

function logKey(log: LogRecord, index: number): string {
  return `${log.timestamp}-${log.span_id}-${index}`;
}

function Attributes({ title, values }: { title: string; values: Record<string, string> }) {
  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;
  return (
    <section className="logDetail__section">
      <h3>{title}</h3>
      <dl className="logDetail__attributes">
        {entries.map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function LogDetail({ log, onClose }: { log: LogRecord; onClose: () => void }) {
  return (
    <aside aria-label="Log details" className="logDetail">
      <header className="logDetail__header">
        <Badge tone={severityTone(log.severity_number)}>{log.severity || "Unset"}</Badge>
        <span>{formatTime(log.timestamp)}</span>
        <IconButton aria-label="Close log details" onClick={onClose}>
          <XIcon size={14} />
        </IconButton>
      </header>
      <pre className="logDetail__body">{log.body}</pre>
      {log.exception_type || log.exception_message ? (
        <section className="logDetail__section">
          <h3>Exception</h3>
          <p className="logDetail__exception">
            {[log.exception_type, log.exception_message].filter(Boolean).join(": ")}
          </p>
          {log.exception_stacktrace ? (
            <pre className="logDetail__body">{log.exception_stacktrace}</pre>
          ) : null}
        </section>
      ) : null}
      <dl className="logDetail__attributes">
        <div><dt>Service</dt><dd>{log.service || "—"}</dd></div>
        {log.trace_id ? <div><dt>Trace ID</dt><dd>{log.trace_id}</dd></div> : null}
        {log.span_id ? <div><dt>Span ID</dt><dd>{log.span_id}</dd></div> : null}
      </dl>
      <Attributes title="Log attributes" values={log.log_attrs} />
      <Attributes title="Resource attributes" values={log.resource_attrs} />
    </aside>
  );
}

export function LogsPage() {
  useDocumentTitle("Logs");
  // Undefined while loading; null when the workspace cannot read telemetry.
  const [projects, setProjects] = useState<TelemetryProject[] | null | undefined>(undefined);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectsAttempt, setProjectsAttempt] = useState(0);
  const [projectId, setProjectId] = useState("");
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
    let cancelled = false;
    fetchTelemetryProjects()
      .then((loaded) => {
        if (cancelled) return;
        setProjects(loaded);
        setProjectsError(null);
        setProjectId(loaded?.[0]?.projectId ?? "");
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setProjectsError(cause instanceof Error ? cause.message : "Unable to load telemetry projects");
        }
      });
    return () => { cancelled = true; };
  }, [projectsAttempt]);

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
      </header>
      {projects === undefined ? (
        projectsError ? (
          <div className="automationRuns__message" role="alert">
            <p>{projectsError}</p>
            <button
              onClick={() => {
                setProjectsError(null);
                setProjectsAttempt((attempt) => attempt + 1);
              }}
              type="button"
            >
              Retry
            </button>
          </div>
        ) : (
          <p className="logsPage__status">Loading…</p>
        )
      ) : projects === null ? (
        <section className="emptyState emptyState--list">
          <h2>Logs are not available</h2>
          <p>This workspace cannot read telemetry yet.</p>
        </section>
      ) : projects.length === 0 ? (
        <section className="emptyState emptyState--list">
          <h2>No telemetry projects</h2>
          <p>Logs appear here once a telemetry project is linked to this workspace.</p>
        </section>
      ) : (
        <section aria-label="Logs" className="logsPage">
          <div className="logsPage__toolbar">
            {projects.length > 1 ? (
              <SelectField
                className="logsPage__select"
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
              className="logsPage__select"
              label="Service"
              onChange={setService}
              options={serviceOptions}
              searchable={serviceOptions.length > 8}
              value={service}
            />
            <SelectField
              className="logsPage__select"
              label="Severity"
              onChange={setSeverity}
              options={severities}
              value={severity}
            />
            <form className="logsPage__search" onSubmit={submitSearch} role="search">
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
            <SegmentedControl aria-label="Time range" onChange={setRange} options={ranges} value={range} />
          </div>
          {error ? (
            <div className="automationRuns__message" role="alert">
              <p>{error}</p>
              <button onClick={() => void load()} type="button">Retry</button>
            </div>
          ) : null}
          <div className={selectedLog ? "logsPage__body logsPage__body--detail" : "logsPage__body"}>
            <div className="agentListTable logsPage__table">
              {logs === null ? (
                <p className="logsPage__status">Loading logs…</p>
              ) : (
                <DataTable<LogRecord & { key: string }>
                  aria-label="Log records"
                  columns={[
                    {
                      header: "Time",
                      key: "time",
                      render: (log) => <time className="logsPage__time" dateTime={logTimestamp(log.timestamp)?.toISOString()}>{formatTime(log.timestamp)}</time>,
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
                      render: (log) => <span className="logsPage__service">{log.service || "—"}</span>,
                      width: "120px",
                    },
                    {
                      header: "Message",
                      key: "message",
                      // A button, so the details open from the keyboard too.
                      render: (log) => (
                        <button
                          aria-expanded={log.key === selected}
                          className="logsPage__message"
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
            {selectedLog ? <LogDetail log={selectedLog} onClose={() => setSelected(null)} /> : null}
          </div>
        </section>
      )}
    </AppShell>
  );
}
