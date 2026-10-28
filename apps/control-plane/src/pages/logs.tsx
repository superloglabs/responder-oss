import { TelemetrySearch } from "../components/telemetry-search";
import { LogFacets } from "../components/log-facets";
import { NavigationIcon } from "../components/navigation-icon";
import { ArrowClockwiseIcon, ArrowLeftIcon, ArrowRightIcon, BugIcon, CaretDownIcon, CaretUpIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AppShell } from "../components/app-shell";
import { DataTableSkeleton, ExplorerSkeleton } from "../components/screen-skeletons";
import { CountHistogram, HistogramLegend, type HistogramSeries } from "../components/count-histogram";
import { DashboardTimePicker } from "../components/dashboard-time-picker";
import { TelemetryGate } from "../components/telemetry";
import {
  AttributeTable,
  ExplorerDrawer,
} from "../components/telemetry-explorer";
import { resolveTimeRange, zoomOutTimeRange } from "../dashboard-time-range";
import { errorLogSeverityNumber, fetchLogErrorIssueId } from "../error-issues-api";
import { fetchAttributeKeys } from "../dashboards-api";
import { DataTable, IconButton } from "../design-system";
import {
  explorerFilterText,
  fetchExplorerLogs,
  fetchLogAttributeFacet,
  fetchLogFacets,
  fetchLogHistogram,
  formatExplorerTime,
  histogramBars,
  levelLabel,
  levelSeries,
  logExplorerParams,
  logExplorerQuery,
  logTimestamp,
  severityTextTone,
  traceHref,
  type ExplorerFilter,
  type LevelSeries,
  type LogExplorerQuery,
  type LogRecord,
} from "../telemetry-api";
import { useDocumentTitle } from "../use-document-title";
import { useTelemetryAvailable } from "../use-telemetry-available";
import { useTelemetryQuery } from "../use-telemetry-query";
import { useTimeZonePreference } from "../use-time-zone-preference";
import "../components/automation-run-history.css";

const levelChart: Array<HistogramSeries<LevelSeries>> = [
  { color: "#e07b73", label: "Error", name: "error" },
  { color: "#e2c68a", label: "Warn", name: "warn" },
  { color: "#c9c9c9", label: "Other", name: "other" },
];
const levelSeriesNames = levelChart.map((series) => series.name);

// Most severe first; levels the list does not know go last.
const levelOrder = ["FATAL", "CRITICAL", "ERROR", "WARN", "WARNING", "INFO", "DEBUG", "TRACE"];
const levelRank = (severity: string) => {
  const index = levelOrder.indexOf(severity.toUpperCase());
  return index === -1 ? levelOrder.length : index;
};

function logKey(log: LogRecord, index: number): string {
  return `${log.timestamp}-${log.span_id}-${index}`;
}

// A log level as a coloured dot and its name.
function LogLevel({ severity }: { severity: string }) {
  return (
    <span className={`explorerLevel explorerLevel--${severityTextTone(severity)}`}>
      <i aria-hidden="true" />{levelLabel(severity)}
    </span>
  );
}

function LogDrawer({
  index,
  log,
  onClose,
  onFilter,
  onMove,
  timeZone,
  total,
}: {
  index: number;
  log: LogRecord;
  onClose: () => void;
  onFilter: (filter: ExplorerFilter) => void;
  onMove: (index: number) => void;
  timeZone: string;
  total: number;
}) {
  const exception = [log.exception_type, log.exception_message].filter(Boolean).join(": ");
  // The exception has its own section.
  const logAttrs = Object.fromEntries(Object.entries(log.log_attrs).filter(([key]) => !key.startsWith("exception.")));
  // Logs below ERROR have no issue.
  const isError = log.severity_number >= errorLogSeverityNumber;
  const issue = useTelemetryQuery(
    isError ? `${log.timestamp}-${log.span_id}-${log.service}-${log.body}` : null,
    () => fetchLogErrorIssueId(log),
  );
  const issueId = isError ? issue.data : null;
  return (
    <ExplorerDrawer
      fullHeight
      header={(
        <>
          <LogLevel severity={log.severity} />
          <time className="explorerCell--number" dateTime={logTimestamp(log.timestamp)?.toISOString()}>
            {formatExplorerTime(log.timestamp, true, timeZone)}
          </time>
          <span className="logDrawer__service">{log.service || "—"}</span>
          <span className="explorerDrawer__spacer" />
          <IconButton aria-label="Previous log" className="explorerDrawer__nav" disabled={index === 0} onClick={() => onMove(index - 1)} size="small">
            <CaretUpIcon size={14} />
          </IconButton>
          <IconButton aria-label="Next log" className="explorerDrawer__nav" disabled={index >= total - 1} onClick={() => onMove(index + 1)} size="small">
            <CaretDownIcon size={14} />
          </IconButton>
        </>
      )}
      label="Log details"
      onClose={onClose}
    >
      <section className="explorerSection">
        <pre className="explorerBlock">{log.body}</pre>
        {log.trace_id || issueId ? (
          <div className="explorerActions">
            {log.trace_id ? (
              <>
                <Link className="dsButton dsButton--primary dsButton--small" to={traceHref(log.trace_id)}>
                  <TreeStructureIcon aria-hidden="true" />Open trace
                </Link>
                <button
                  className="dsButton dsButton--secondary dsButton--small"
                  onClick={() => onFilter({ key: "field.trace_id", op: "eq", value: log.trace_id })}
                  type="button"
                >
                  Logs in this trace
                </button>
              </>
            ) : null}
            {issueId ? (
              <Link className="dsButton dsButton--secondary dsButton--small" to={`/errors/${encodeURIComponent(issueId)}`}>
                <BugIcon aria-hidden="true" />Open error
              </Link>
            ) : null}
          </div>
        ) : null}
      </section>
      {exception || log.exception_stacktrace ? (
        <section className="explorerSection">
          <header><h3>Exception</h3></header>
          <pre className="explorerBlock explorerBlock--exception">
            {exception ? <strong>{exception}</strong> : null}
            {log.exception_stacktrace}
          </pre>
        </section>
      ) : null}
      <AttributeTable
        grouped
        key={logKeyForAttributes(log)}
        leading={[
          ...(log.trace_id ? [{ key: "trace_id", value: <Link to={traceHref(log.trace_id)}>{log.trace_id}</Link> }] : []),
          ...(log.span_id ? [{ key: "span_id", value: log.span_id }] : []),
        ]}
        onFilter={(key, op, value) => onFilter({ key, op, value })}
        scopes={[
          { label: "Log", prefix: "log.", values: logAttrs },
          { label: "Resource", prefix: "resource.", values: log.resource_attrs, defaultCollapsed: true },
        ]}
      />
    </ExplorerDrawer>
  );
}

// Keeps the attribute table's groups and search across logs from one source.
function logKeyForAttributes(log: LogRecord): string {
  return log.service;
}

function LogExplorer({ query, refresh, setQuery, timeZone, now }: {
  query: LogExplorerQuery;
  now: number;
  // Changes when someone asks to reload.
  refresh: number;
  setQuery: (update: Partial<LogExplorerQuery>) => void;
  timeZone: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  // Opening a facet does not reload the rest of the page.
  const params = logExplorerParams({ ...query, facets: [] });
  const key = `${params}#${refresh}`;
  const rangeKey = `${["range", "from", "to"].map((name) => params.get(name) ?? "").join("|")}#${refresh}`;
  const [pagination, setPagination] = useState({ key, page: 0 });
  const page = pagination.key === key ? pagination.page : 0;
  if (pagination.key !== key) setPagination({ key, page: 0 });
  const window = resolveTimeRange(query.range, now);
  const requestQuery: LogExplorerQuery = { ...query, range: { kind: "absolute", from: window.since, to: window.until } };
  const logs = useTelemetryQuery(`${key}#${page}`, () => fetchExplorerLogs(requestQuery, page * 100), false, true);
  const histogram = useTelemetryQuery(key, () => fetchLogHistogram(requestQuery), false, true);
  const facets = useTelemetryQuery(key, () => fetchLogFacets(requestQuery), false, true);
  const attributeKeys = useTelemetryQuery(rangeKey, () => fetchAttributeKeys(resolveTimeRange(query.range, now), "logs"));

  const tableWrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = tableWrap.current?.querySelector(".dsDataTable");
    if (viewport && !logs.isFetching) viewport.scrollTop = 0;
  }, [logs.data, logs.isFetching]);

  const bars = useMemo(
    () => (histogram.data ? histogramBars(histogram.data, levelSeriesNames, levelSeries) : null),
    [histogram.data],
  );
  const total = bars?.reduce((sum, bar) => sum + bar.total, 0);
  const rows = useMemo(() => (logs.data ?? []).map((log, index) => ({ ...log, key: logKey(log, index) })), [logs.data]);
  const selectedIndex = rows.findIndex((row) => row.key === selected);
  const selectedLog = selectedIndex >= 0 ? rows[selectedIndex] : null;
  // Dates show for fixed windows and for the last day or more.
  const withDate = query.range.kind === "absolute" || query.range.minutes >= 1_440;

  function toggle(list: "services" | "severities", value: string) {
    const current = query[list];
    setQuery({ [list]: current.includes(value) ? current.filter((item) => item !== value) : [...current, value] });
  }

  function addFilter(filter: ExplorerFilter) {
    const text = explorerFilterText(filter);
    setQuery({ filters: [...query.filters.filter((item) => explorerFilterText(item) !== text), filter] });
  }

  return (
    <>
      <div className="explorerToolbar">
        <TelemetrySearch
          signal="logs"
          query={query}
          onChange={setQuery}
          dataKey={key}
          attributeKeys={attributeKeys.data}
          keysError={attributeKeys.error}
          onRetryKeys={attributeKeys.retry}
          loadValues={async (field) => {
            if (field === "service" || field === "severity") {
              const data = facets.data ?? await fetchLogFacets(requestQuery);
              return field === "service" ? data.services : data.severities;
            }
            return fetchLogAttributeFacet(requestQuery, field);
          }}
        />
      </div>
      <section aria-label="Log volume" aria-busy={histogram.isFetching} className="explorerVolume">
        <div className="explorerVolume__summary">
          <strong>{total === undefined ? "…" : `${total.toLocaleString()} ${total === 1 ? "log" : "logs"}`}</strong>
          <HistogramLegend bars={bars} series={levelChart} />
        </div>
        <CountHistogram bars={bars} label="Matching logs over time, by level" series={levelChart} timeZone={timeZone} />
      </section>
      {logs.error || histogram.error || facets.error ? (
        <div className="automationRuns__message" role="alert">
          <p>{logs.error ?? histogram.error ?? facets.error}</p>
          <button onClick={() => { logs.retry(); histogram.retry(); facets.retry(); }} type="button">Retry</button>
        </div>
      ) : null}
      <div className="explorerBody explorerBody--search">
        <LogFacets
          dataKey={key}
          filters={query.filters}
          keys={attributeKeys.data}
          load={(facetKey) => fetchLogAttributeFacet(requestQuery, facetKey)}
          onFiltersChange={(filters) => setQuery({ filters })}
          onOpenChange={(facets) => setQuery({ facets })}
          open={query.facets}
          services={{ loading: !facets.data, selected: query.services, onToggle: value => toggle("services", value), options: (facets.data?.services ?? []).filter(item => item.group).map(item => ({ count: item.value, label: item.group, value: item.group })) }}
          levels={{ loading: !facets.data, selected: query.severities, onToggle: value => toggle("severities", value), options: (facets.data?.severities ?? []).filter(item => item.group).toSorted((a, b) => levelRank(a.group) - levelRank(b.group)).map(item => ({ count: item.value, label: levelLabel(item.group), value: item.group, color: severityTextTone(item.group) === "danger" ? "#d77878" : severityTextTone(item.group) === "warning" ? "#d8b971" : "#4e58f9" })) }}
        />
        <div className="agentListTable explorerTableWrap" ref={tableWrap}>
          <div className="explorerResults" aria-busy={logs.isFetching}>
          {logs.data === null ? (
            logs.error ? null : (
              <DataTableSkeleton
                className=""
                columns={[
                  { header: "Time", key: "time", width: withDate ? "176px" : "124px" },
                  { cell: "badge", header: "Level", key: "severity", width: "76px" },
                  { header: "Service", key: "service", width: "220px" },
                  { header: "Message", key: "message" },
                ]}
                label="Loading logs…"
                rows={12}
              />
            )
          ) : (
            <DataTable<LogRecord & { key: string }>
              aria-label="Log records"
              columns={[
                {
                  header: "Time",
                  key: "time",
                  render: (log) => (
                    <time className="explorerCell--muted logTime" dateTime={logTimestamp(log.timestamp)?.toISOString()}>
                      {formatExplorerTime(log.timestamp, withDate, timeZone)}
                    </time>
                  ),
                  width: withDate ? "176px" : "124px",
                },
                {
                  header: "Level",
                  key: "severity",
                  render: (log) => <LogLevel severity={log.severity} />,
                  width: "76px",
                },
                {
                  header: "Service",
                  key: "service",
                  render: (log) => <span className="logService" title={log.service || undefined}>{log.service || "—"}</span>,
                  width: "220px",
                },
                {
                  header: "Message",
                  key: "message",
                  // A button, so the details open from the keyboard too.
                  render: (log) => (
                    <button
                      aria-expanded={log.key === selected}
                      className="explorerCell--message"
                      onClick={() => setSelected(log.key === selected ? null : log.key)}
                      title={log.body}
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
              rows={rows}
              selectedRowKey={selected}
              variant="workspace"
            />
          )}
          </div>
          <nav className="logPagination" aria-label="Log pagination">
            <span>{logs.data && !logs.isFetching ? `${rows.length ? page * 100 + 1 : 0}–${page * 100 + rows.length} of ${total?.toLocaleString() ?? "…"} logs` : "Loading logs…"}</span>
            <span>Page {page + 1}{total !== undefined ? ` of ${Math.max(1, Math.ceil(total / 100))}` : ""}</span>
            <button className="dsButton dsButton--secondary dsButton--small" type="button" disabled={page === 0 || logs.isFetching || logs.data === null} onClick={() => { setSelected(null); setPagination({ key, page: page - 1 }); }}><ArrowLeftIcon size={12} />Previous</button>
            <button className="dsButton dsButton--secondary dsButton--small" type="button" disabled={logs.isFetching || logs.data === null || rows.length < 100 || (total !== undefined && (page + 1) * 100 >= total)} onClick={() => { setSelected(null); setPagination({ key, page: page + 1 }); }}>Next<ArrowRightIcon size={12} /></button>
          </nav>
        </div>
      </div>
      {selectedLog ? (
        <LogDrawer
          index={selectedIndex}
          log={selectedLog}
          onClose={() => setSelected(null)}
          onFilter={(filter) => { addFilter(filter); setSelected(null); }}
          onMove={(index) => setSelected(rows[index]?.key ?? null)}
          timeZone={timeZone}
          total={rows.length}
        />
      ) : null}
    </>
  );
}

export function LogsPage() {
  useDocumentTitle("Logs");
  const telemetry = useTelemetryAvailable();
  const [params, setParams] = useSearchParams();
  const query = logExplorerQuery(params);
  const { changeTimeZone, timeZone, timeZonePreference } = useTimeZonePreference();
  const [now, setNow] = useState(() => Date.now());
  const [refresh, setRefresh] = useState(0);

  function setQuery(update: Partial<LogExplorerQuery>) {
    if (update.range) setNow(Date.now());
    setParams(logExplorerParams({ ...query, ...update }), { replace: true });
  }

  function reload() {
    setNow(Date.now());
    setRefresh((count) => count + 1);
  }

  return (
    <AppShell active="logs" redesigned wide>
      <div className="explorer">
        <header className="workspaceHeading">
          <h1><NavigationIcon section="logs" />Logs</h1>
          {telemetry.available ? (
            <div className="workspaceHeading__actions">
              <IconButton aria-label="Refresh" onClick={reload} size="small" variant="ghost">
                <ArrowClockwiseIcon size={14} />
              </IconButton>
              <DashboardTimePicker
                now={now}
                onChange={(range) => setQuery({ range })}
                onTimeZoneChange={changeTimeZone}
                onZoomOut={() => setQuery({ range: zoomOutTimeRange(query.range, Date.now(), null).range })}
                range={query.range}
                timeZone={timeZone}
                timeZonePreference={timeZonePreference}
                zoomed={false}
              />
            </div>
          ) : null}
        </header>
        <TelemetryGate signal="Logs" skeleton={<ExplorerSkeleton label="Loading logs…" />} state={telemetry}>
          <LogExplorer now={now} query={query} refresh={refresh} setQuery={setQuery} timeZone={timeZone} />
        </TelemetryGate>
      </div>
    </AppShell>
  );
}

