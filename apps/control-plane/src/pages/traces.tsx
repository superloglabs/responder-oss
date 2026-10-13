import { CaretRightIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AppShell } from "../components/app-shell";
import { TelemetryProjectsGate } from "../components/telemetry";
import { DataTable, SegmentedControl, SelectField } from "../design-system";
import {
  fetchServices,
  fetchTraces,
  formatDuration,
  formatTelemetryTime,
  logTimestamp,
  telemetryRanges,
  traceHref,
  type TelemetryRange,
  type TraceListState,
  type TraceQuery,
  type TraceSummary,
} from "../telemetry-api";
import { useTelemetryProjects } from "../use-telemetry-projects";
import { useDocumentTitle } from "../use-document-title";
import "../components/automation-run-history.css";

const statuses: Array<{ label: string; value: TraceQuery["status"] }> = [
  { label: "All statuses", value: "" },
  { label: "With errors", value: "error" },
];

const durations = [
  { label: "Any duration", value: "0" },
  { label: "Over 100 ms", value: "100" },
  { label: "Over 500 ms", value: "500" },
  { label: "Over 1 s", value: "1000" },
  { label: "Over 5 s", value: "5000" },
];

const rangeValues = new Set<string>(telemetryRanges.map((range) => range.value));

// Filters live in the URL, so returning from a trace restores them.
function traceFilters(params: URLSearchParams): TraceQuery {
  const range = params.get("range") ?? "";
  const minDurationMs = Number(params.get("minDurationMs"));
  return {
    minDurationMs: durations.some((option) => Number(option.value) === minDurationMs) ? minDurationMs : 0,
    projectId: params.get("projectId") ?? "",
    range: rangeValues.has(range) ? (range as TelemetryRange) : "1h",
    service: params.get("service") ?? "",
    status: params.get("status") === "error" ? "error" : "",
  };
}

function count(value: number | string): number {
  return Number(value) || 0;
}

export function TracesPage() {
  useDocumentTitle("Traces");
  const navigate = useNavigate();
  const telemetry = useTelemetryProjects();
  const [params, setParams] = useSearchParams();
  const filters = traceFilters(params);
  const projectId = filters.projectId || telemetry.projects?.[0]?.projectId || "";
  const { minDurationMs, range, service, status } = filters;
  const listState: TraceListState = { traceList: params.toString() };
  const [services, setServices] = useState<string[]>([]);
  const [traces, setTraces] = useState<TraceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  function setFilter(key: keyof TraceQuery, value: string) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value && value !== "0") next.set(key, value);
      else next.delete(key);
      // A service from one project means nothing in another.
      if (key === "projectId") next.delete("service");
      return next;
    }, { replace: true });
  }

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    fetchServices(projectId, range, "traces")
      .then((loaded) => { if (!cancelled) setServices(loaded); })
      .catch(() => { if (!cancelled) setServices([]); });
    return () => { cancelled = true; };
  }, [projectId, range]);

  const load = useCallback(async () => {
    if (!projectId) return;
    const generation = ++request.current;
    setTraces(null);
    try {
      const loaded = await fetchTraces({ minDurationMs, projectId, range, service, status });
      if (request.current !== generation) return;
      setTraces(loaded);
      setError(null);
    } catch (cause) {
      if (request.current !== generation) return;
      setTraces([]);
      setError(cause instanceof Error ? cause.message : "Unable to load traces");
    }
  }, [minDurationMs, projectId, range, service, status]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => { request.current += 1; };
  }, [load]);

  const serviceOptions = [
    { label: "All services", value: "" },
    // Keep a chosen service listed after it leaves the window.
    ...[...new Set([...services, ...(service ? [service] : [])])]
      .sort()
      .map((name) => ({ label: name, value: name })),
  ];

  return (
    <AppShell active="traces" redesigned>
      <header className="workspaceHeading">
        <h1><TreeStructureIcon aria-hidden="true" size={16} weight="bold" />Traces</h1>
      </header>
      <TelemetryProjectsGate signal="Traces" state={telemetry}>
        {(projects) => (
          <section aria-label="Traces" className="telemetryPage">
            <div className="telemetryPage__toolbar">
              {projects.length > 1 ? (
                <SelectField
                  className="telemetryPage__select"
                  label="Project"
                  onChange={(value) => setFilter("projectId", value)}
                  options={projects.map((project) => ({ label: project.name, value: project.projectId }))}
                  value={projectId}
                />
              ) : null}
              <SelectField
                className="telemetryPage__select"
                label="Service"
                onChange={(value) => setFilter("service", value)}
                options={serviceOptions}
                searchable={serviceOptions.length > 8}
                value={service}
              />
              <SelectField
                className="telemetryPage__select"
                label="Status"
                onChange={(value) => setFilter("status", value)}
                options={statuses}
                value={status}
              />
              <SelectField
                className="telemetryPage__select"
                label="Duration"
                onChange={(value) => setFilter("minDurationMs", value)}
                options={durations}
                value={String(minDurationMs)}
              />
              <SegmentedControl
                aria-label="Time range"
                onChange={(value) => setFilter("range", value)}
                options={telemetryRanges}
                value={range}
              />
            </div>
            {error ? (
              <div className="automationRuns__message" role="alert">
                <p>{error}</p>
                <button onClick={() => void load()} type="button">Retry</button>
              </div>
            ) : null}
            <div className="agentListTable telemetryPage__table">
              {traces === null ? (
                <p className="telemetryPage__status">Loading traces…</p>
              ) : (
                <DataTable<TraceSummary>
                  aria-label="Traces"
                  columns={[
                    {
                      header: "Started",
                      key: "time",
                      render: (trace) => (
                        <time className="telemetryPage__time" dateTime={logTimestamp(trace.start_time)?.toISOString()}>
                          {formatTelemetryTime(trace.start_time)}
                        </time>
                      ),
                      width: "130px",
                    },
                    {
                      header: "Service",
                      key: "service",
                      render: (trace) => <span className="telemetryPage__service">{trace.root_service || "—"}</span>,
                      width: "140px",
                    },
                    {
                      header: "Root span",
                      key: "root",
                      render: (trace) => (
                        <Link
                          className="telemetryPage__message"
                          state={listState}
                          title={trace.root_span_name}
                          to={traceHref(projectId, trace.trace_id)}
                        >
                          {trace.root_span_name || trace.trace_id}
                        </Link>
                      ),
                    },
                    {
                      align: "right",
                      header: "Duration",
                      key: "duration",
                      render: (trace) => <span className="telemetryPage__number">{formatDuration(trace.duration_ms)}</span>,
                      width: "96px",
                    },
                    {
                      align: "right",
                      header: "Spans",
                      key: "spans",
                      render: (trace) => <span className="telemetryPage__number">{count(trace.span_count).toLocaleString()}</span>,
                      width: "72px",
                    },
                    {
                      header: "Errors",
                      key: "errors",
                      render: (trace) => count(trace.error_count) > 0
                        ? <span className="telemetryPage__errors">{count(trace.error_count).toLocaleString()}</span>
                        : <span className="telemetryPage__service">—</span>,
                      width: "80px",
                    },
                    {
                      header: "",
                      key: "open",
                      render: () => <CaretRightIcon aria-hidden="true" className="automationRuns__open" size={14} />,
                      width: "44px",
                    },
                  ]}
                  emptyMessage="No traces match these filters in this time range."
                  getRowKey={(trace) => trace.trace_id}
                  onRowClick={(trace) => navigate(traceHref(projectId, trace.trace_id), { state: listState })}
                  rows={traces}
                  variant="workspace"
                />
              )}
            </div>
          </section>
        )}
      </TelemetryProjectsGate>
    </AppShell>
  );
}
