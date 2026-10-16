import { ArrowClockwiseIcon, CaretDownIcon, CaretUpIcon, ListMagnifyingGlassIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AppShell } from "../components/app-shell";
import { CountHistogram, HistogramLegend, type HistogramSeries } from "../components/count-histogram";
import { DashboardTimePicker } from "../components/dashboard-time-picker";
import { TelemetryGate } from "../components/telemetry";
import {
  AddFacet,
  AttributeTable,
  ExplorerDrawer,
  ExplorerFacet,
  ExplorerFilterBar,
  type FilterChip,
} from "../components/telemetry-explorer";
import { resolveTimeRange, zoomOutTimeRange } from "../dashboard-time-range";
import { fetchAttributeKeys } from "../dashboards-api";
import { DataTable, IconButton } from "../design-system";
import {
  explorerFilterText,
  fetchExplorerLogs,
  fetchLogFacets,
  fetchLogHistogram,
  formatExplorerTime,
  histogramBars,
  levelLabel,
  levelSeries,
  logExplorerParams,
  logExplorerQuery,
  logTimestamp,
  parseExplorerFilter,
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

const traceIdPattern = /^[0-9a-f]{32}$/iu;

// Most severe first; levels the list does not know go last.
const levelOrder = ["FATAL", "CRITICAL", "ERROR", "WARN", "WARNING", "INFO", "DEBUG", "TRACE"];
const levelRank = (severity: string) => {
  const index = levelOrder.indexOf(severity.toUpperCase());
  return index === -1 ? levelOrder.length : index;
};

// Readable names for filter keys in chips.
function filterChipLabel(filter: ExplorerFilter): string {
  const key = filter.key.replace(/^(log|resource|field)\./u, "");
  return filter.op === "neq" ? `not ${key}` : key;
}

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
  return (
    <ExplorerDrawer
      header={(
        <>
          <LogLevel severity={log.severity} />
          <time className="explorerCell--number" dateTime={logTimestamp(log.timestamp)?.toISOString()}>
            {formatExplorerTime(log.timestamp, true, timeZone)}
          </time>
          <span className="explorerCell--muted">{log.service || "—"}</span>
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
        {log.trace_id ? (
          <div className="explorerActions">
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
        key={logKeyForAttributes(log)}
        leading={[
          ...(log.trace_id ? [{ key: "trace_id", value: <Link to={traceHref(log.trace_id)}>{log.trace_id}</Link> }] : []),
          ...(log.span_id ? [{ key: "span_id", value: log.span_id }] : []),
        ]}
        onFilter={(key, op, value) => onFilter({ key, op, value })}
        scopes={[
          { label: "Log", prefix: "log.", values: logAttrs },
          { label: "Resource", prefix: "resource.", values: log.resource_attrs },
        ]}
      />
    </ExplorerDrawer>
  );
}

// Keeps the attribute table's tab and search across logs from one source.
function logKeyForAttributes(log: LogRecord): string {
  return log.service;
}

function LogExplorer({ query, refresh, setQuery, timeZone }: {
  query: LogExplorerQuery;
  // Changes when someone asks to reload.
  refresh: number;
  setQuery: (update: Partial<LogExplorerQuery>) => void;
  timeZone: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const params = logExplorerParams(query);
  const key = `${params}#${refresh}`;
  const rangeKey = `${["range", "from", "to"].map((name) => params.get(name) ?? "").join("|")}#${refresh}`;
  const logs = useTelemetryQuery(key, () => fetchExplorerLogs(query));
  const histogram = useTelemetryQuery(key, () => fetchLogHistogram(query));
  const facets = useTelemetryQuery(key, () => fetchLogFacets(query));
  const attributeKeys = useTelemetryQuery(rangeKey, () => fetchAttributeKeys(resolveTimeRange(query.range, Date.now()), "logs"));

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

  function submitText(text: string): boolean {
    if (!text) {
      if (query.search) setQuery({ search: "" });
      return true;
    }
    if (traceIdPattern.test(text)) {
      addFilter({ key: "field.trace_id", op: "eq", value: text.toLowerCase() });
      return true;
    }
    const filter = /^[\w.-]+!?=/u.test(text) ? parseExplorerFilter(text) : null;
    if (filter) {
      addFilter(filter);
      return true;
    }
    setQuery({ search: text });
    return false;
  }

  const chips: FilterChip[] = [
    ...query.services.map((service) => ({
      id: `service-${service}`,
      label: "service",
      onRemove: () => toggle("services", service),
      value: service,
    })),
    ...query.severities.map((severity) => ({
      id: `level-${severity}`,
      label: "level",
      onRemove: () => toggle("severities", severity),
      value: levelLabel(severity),
    })),
    ...query.filters.map((filter) => ({
      id: `filter-${explorerFilterText(filter)}`,
      label: filterChipLabel(filter),
      onRemove: () => setQuery({ filters: query.filters.filter((item) => item !== filter) }),
      value: filter.value,
    })),
  ];

  return (
    <>
      <div className="explorerToolbar">
        <ExplorerFilterBar
          chips={chips}
          initialText={query.search}
          label="Search logs"
          onSubmit={submitText}
          placeholder="Search messages, key=value or a trace ID"
        />
      </div>
      <section aria-label="Log volume" className="explorerVolume">
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
      <div className="explorerBody">
        <div aria-label="Log filters" className="explorerFacets" role="group">
          <ExplorerFacet
            loading={!facets.data}
            onToggle={(value) => toggle("severities", value)}
            options={(facets.data?.severities ?? [])
              .filter((item) => item.group)
              .toSorted((a, b) => levelRank(a.group) - levelRank(b.group))
              .map((item) => ({ count: item.value, label: levelLabel(item.group), value: item.group }))}
            selected={query.severities}
            title="Level"
          />
          <ExplorerFacet
            loading={!facets.data}
            onToggle={(value) => toggle("services", value)}
            options={(facets.data?.services ?? [])
              .filter((item) => item.group)
              .map((item) => ({ count: item.value, label: item.group, value: item.group }))}
            selected={query.services}
            title="Service"
          />
          {query.facets.map((facetKey) => {
            const selectedValues = query.filters
              .filter((filter) => filter.key === facetKey && filter.op === "eq")
              .map((filter) => filter.value);
            return (
              <ExplorerFacet
                key={facetKey}
                loading={!facets.data}
                onRemove={() => setQuery({
                  facets: query.facets.filter((item) => item !== facetKey),
                  filters: query.filters.filter((filter) => filter.key !== facetKey),
                })}
                onToggle={(value) => {
                  const existing = query.filters.find((filter) => filter.key === facetKey && filter.op === "eq" && filter.value === value);
                  // One value per key: attribute filters on a key must all match.
                  setQuery({
                    filters: existing
                      ? query.filters.filter((filter) => filter !== existing)
                      : [...query.filters.filter((filter) => filter.key !== facetKey), { key: facetKey, op: "eq", value }],
                  });
                }}
                options={(facets.data?.attributes[facetKey] ?? [])
                  .filter((item) => item.group)
                  .map((item) => ({ count: item.value, label: item.group, value: item.group }))}
                selected={selectedValues}
                title={facetKey.replace(/^(log|resource)\./u, "")}
              />
            );
          })}
          <AddFacet
            keys={(attributeKeys.data ?? []).filter((item) => !query.facets.includes(item))}
            onAdd={(facetKey) => setQuery({ facets: [...query.facets, facetKey] })}
          />
        </div>
        <div className="agentListTable explorerTableWrap">
          {logs.data === null ? (
            logs.error ? null : <p className="explorerStatus">Loading logs…</p>
          ) : (
            <DataTable<LogRecord & { key: string }>
              aria-label="Log records"
              columns={[
                {
                  header: "Time",
                  key: "time",
                  render: (log) => (
                    <time className="explorerCell--muted" dateTime={logTimestamp(log.timestamp)?.toISOString()}>
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
                  render: (log) => <span className="explorerCell--muted" title={log.service || undefined}>{log.service || "—"}</span>,
                  width: "128px",
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
          {rows.length >= 100 ? <p className="explorerMore">Showing the newest 100 logs. Narrow the filters to see others.</p> : null}
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
          <h1><ListMagnifyingGlassIcon aria-hidden="true" size={16} weight="bold" />Logs</h1>
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
        <TelemetryGate signal="Logs" state={telemetry}>
          <LogExplorer query={query} refresh={refresh} setQuery={setQuery} timeZone={timeZone} />
        </TelemetryGate>
      </div>
    </AppShell>
  );
}

