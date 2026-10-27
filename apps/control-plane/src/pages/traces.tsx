import { ArrowClockwiseIcon, ArrowLeftIcon, ArrowRightIcon } from "@phosphor-icons/react";
import { ExplorerFacets } from "../components/explorer-facets";
import { DashboardTimePicker } from "../components/dashboard-time-picker";
import { resolveTimeRange, zoomOutTimeRange } from "../dashboard-time-range";
import { useTimeZonePreference } from "../use-time-zone-preference";
import { NavigationIcon } from "../components/navigation-icon";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AppShell } from "../components/app-shell";
import { DataTableSkeleton, ExplorerSkeleton } from "../components/screen-skeletons";
import { CountHistogram, HistogramLegend, type HistogramSeries } from "../components/count-histogram";
import { TelemetryGate } from "../components/telemetry";
import {
  ExplorerFilterBar,
  type FilterChip,
} from "../components/telemetry-explorer";
import { TraceDrawer } from "../components/trace-drawer";
import { fetchAttributeKeys } from "../dashboards-api";
import { DataTable, IconButton } from "../design-system";
import {
  explorerFilterText,
  fetchExplorerTraces,
  fetchTraceAttributeFacet,
  fetchTraceFacets,
  fetchTraceHistogram,
  formatDuration,
  formatTraceTimestamp,
  histogramBars,
  logTimestamp,
  parseExplorerFilter,
  traceExplorerParams,
  traceSearchQuery,
  type ExplorerFilter,
  type TraceSearchQuery,
  type TraceListState,
  type TraceSummary,
} from "../telemetry-api";
import { useDocumentTitle } from "../use-document-title";
import { useTelemetryAvailable } from "../use-telemetry-available";
import { useTelemetryQuery } from "../use-telemetry-query";
import "../components/automation-run-history.css";

type StatusSeries = "error" | "other";

const statusChart: Array<HistogramSeries<StatusSeries>> = [
  { color: "#e07b73", label: "Error", name: "error" },
  { color: "#c9c9c9", label: "OK or unset", name: "other" },
];
const statusSeriesNames = statusChart.map((series) => series.name);
const statusSeries = (group: string): StatusSeries => (group === "STATUS_CODE_ERROR" ? "error" : "other");

const statusLabels: Record<string, string> = {
  STATUS_CODE_ERROR: "Error",
  STATUS_CODE_OK: "OK",
  STATUS_CODE_UNSET: "Unset",
};

const durations = [
  { label: "Over 100 ms", value: "100" },
  { label: "Over 500 ms", value: "500" },
  { label: "Over 1 s", value: "1000" },
  { label: "Over 5 s", value: "5000" },
];

const traceIdPattern = /^[0-9a-f]{32}$/iu;

function count(value: number | string): number {
  return Number(value) || 0;
}

function filterChipLabel(filter: ExplorerFilter): string {
  const key = filter.key.replace(/^(span|resource|field)\./u, "");
  return filter.op === "neq" ? `not ${key}` : key;
}

function TraceExplorer({ now, refresh, timeZone, onOpenTrace, openTrace, query, setQuery }: {
  now: number;
  refresh: number;
  timeZone: string;
  onOpenTrace: (traceId: string | null) => void;
  openTrace: string | null;
  query: TraceSearchQuery;
  setQuery: (update: Partial<TraceSearchQuery>) => void;
}) {
  // Opening a facet does not reload the rest of the page.
  const params = traceExplorerParams({ ...query, facets: [] });
  const key = `${params}#${refresh}`;
  const rangeKey = `${["range", "from", "to"].map((name) => params.get(name) ?? "").join("|")}#${refresh}`;
  const window = resolveTimeRange(query.range, now);
  const requestQuery: TraceSearchQuery = { ...query, range: { kind: "absolute", from: window.since, to: window.until } };
  const [pagination, setPagination] = useState({ key, page: 0 });
  const page = pagination.key === key ? pagination.page : 0;
  if (pagination.key !== key) setPagination({ key, page: 0 });
  const traces = useTelemetryQuery(`${key}#${page}`, () => fetchExplorerTraces(requestQuery, page * 50), false, true);
  const rows = traces.data?.slice(0, 50) ?? [];
  const hasNext = (traces.data?.length ?? 0) > 50;
  const histogram = useTelemetryQuery(key, () => fetchTraceHistogram(requestQuery), false, true);
  const facets = useTelemetryQuery(key, () => fetchTraceFacets(requestQuery), false, true);
  const attributeKeys = useTelemetryQuery(rangeKey, () => fetchAttributeKeys(window, "traces"));
  const tableWrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = tableWrap.current?.querySelector(".dsDataTable");
    if (viewport && !traces.isFetching) viewport.scrollTop = 0;
  }, [traces.data, traces.isFetching]);
  const bars = useMemo(
    () => (histogram.data ? histogramBars(histogram.data, statusSeriesNames, statusSeries) : null),
    [histogram.data],
  );
  const total = bars?.reduce((sum, bar) => sum + bar.total, 0);
  const longest = Math.max(1, ...rows.map((trace) => trace.duration_ms));
  const listState: TraceListState = { traceList: traceExplorerParams(query).toString() };

  function toggle(list: "operations" | "services" | "statuses", value: string) {
    const current = query[list];
    setQuery({ [list]: current.includes(value) ? current.filter((item) => item !== value) : [...current, value] });
  }

  function addFilter(filter: ExplorerFilter) {
    const text = explorerFilterText(filter);
    setQuery({ filters: [...query.filters.filter((item) => explorerFilterText(item) !== text), filter] });
  }

  function submitText(text: string): boolean {
    if (!text) return true;
    if (traceIdPattern.test(text)) {
      onOpenTrace(text.toLowerCase());
      return true;
    }
    const filter = /^[\w.-]+!?=/u.test(text) ? parseExplorerFilter(text) : null;
    if (filter) addFilter(filter);
    else if (!query.operations.includes(text)) setQuery({ operations: [...query.operations, text] });
    return true;
  }

  const chips: FilterChip[] = [
    ...query.services.map((value) => ({ id: `service-${value}`, label: "service", onRemove: () => toggle("services", value), value })),
    ...query.operations.map((value) => ({ id: `operation-${value}`, label: "span", onRemove: () => toggle("operations", value), value })),
    ...query.statuses.map((value) => ({
      id: `status-${value}`,
      label: "status",
      onRemove: () => toggle("statuses", value),
      value: statusLabels[value] ?? value,
    })),
    ...(query.minDurationMs > 0
      ? [{ id: "duration", label: "duration", onRemove: () => setQuery({ minDurationMs: 0 }), value: `> ${formatDuration(query.minDurationMs)}` }]
      : []),
    ...query.filters
      .map((filter) => ({
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
          label="Filter traces"
          onSubmit={submitText}
          placeholder="Span name, key=value or a trace ID"
        />
      </div>
      <section aria-label="Span volume" aria-busy={histogram.isFetching} className="explorerVolume">
        <div className="explorerVolume__summary">
          <strong>{total === undefined ? "…" : `${total.toLocaleString()} ${total === 1 ? "span" : "spans"}`}</strong>
          <HistogramLegend bars={bars} series={statusChart} />
        </div>
        <CountHistogram bars={bars} label="Matching spans over time, by status" series={statusChart} timeZone={timeZone} />
      </section>
      {traces.error || histogram.error || facets.error ? (
        <div className="automationRuns__message" role="alert">
          <p>{traces.error ?? histogram.error ?? facets.error}</p>
          <button onClick={() => { traces.retry(); histogram.retry(); facets.retry(); }} type="button">Retry</button>
        </div>
      ) : null}
      <div className="explorerBody explorerBody--search">
        <ExplorerFacets
          label="Trace filters"
          dataKey={key}
          filters={query.filters}
          keys={attributeKeys.data}
          load={(facetKey) => fetchTraceAttributeFacet(requestQuery, facetKey)}
          onFiltersChange={(filters) => setQuery({ filters })}
          onOpenChange={(facets) => setQuery({ facets })}
          open={query.facets}
          scopes={[
            { title: "Resource attributes", prefix: "resource.", primary: [{
              title: "Service", loading: !facets.data, selected: query.services,
              onToggle: (value) => toggle("services", value),
              options: (facets.data?.services ?? []).filter((item) => item.group).map((item) => ({ count: item.value, label: item.group, value: item.group })),
            }] },
            { title: "Span attributes", prefix: "span.", primary: [
              {
                title: "Status", loading: !facets.data, selected: query.statuses,
                onToggle: (value) => toggle("statuses", value),
                options: [...(facets.data?.statuses ?? [])]
                  .sort((a, b) => Object.keys(statusLabels).indexOf(a.group) - Object.keys(statusLabels).indexOf(b.group))
                  .map((item) => ({ count: item.value, label: statusLabels[item.group] ?? item.group, value: item.group, color: item.group === "STATUS_CODE_ERROR" ? "#d77878" : "#4e58f9" })),
              },
              {
                title: "Span name", loading: !facets.data, selected: query.operations,
                onToggle: (value) => toggle("operations", value),
                options: (facets.data?.operations ?? []).filter((item) => item.group).map((item) => ({ count: item.value, label: item.group, value: item.group })),
              },
              {
                title: "Trace duration", loading: false,
                selected: query.minDurationMs > 0 ? [String(query.minDurationMs)] : [],
                onToggle: (value) => setQuery({ minDurationMs: Number(value) === query.minDurationMs ? 0 : Number(value) }),
                options: durations,
              },
            ] },
          ]}
        />
        <div className="agentListTable explorerTableWrap" ref={tableWrap}>
          <div className="explorerResults explorerResults--traces" aria-busy={traces.isFetching}>
          {traces.data === null ? (
            traces.error ? null : (
              <DataTableSkeleton
                className=""
                columns={[
                  { header: "Started", key: "time", width: "200px" },
                  { header: "Root span", key: "root" },
                  { header: "Duration", key: "duration", width: "180px" },
                  { align: "right", header: "Spans", key: "spans", width: "72px" },
                  { header: "Status", key: "status", width: "104px" },
                ]}
                label="Loading traces…"
                rows={12}
              />
            )
          ) : (
            <DataTable<TraceSummary>
              aria-label="Traces"
              columns={[
                {
                  header: "Started",
                  key: "time",
                  render: (trace) => (
                    <time className="traceRow__timestamp" dateTime={logTimestamp(trace.start_time)?.toISOString()}>
                      {formatTraceTimestamp(trace.start_time, timeZone)}
                    </time>
                  ),
                  width: "200px",
                },
                {
                  header: "Root span",
                  key: "root",
                  render: (trace) => {
                    const services = count(trace.service_count);
                    return (
                      <span className="traceRow__root">
                        <button
                          aria-expanded={trace.trace_id === openTrace}
                          className="explorerCell--message"
                          onClick={() => onOpenTrace(trace.trace_id === openTrace ? null : trace.trace_id)}
                          title={trace.root_span_name}
                          type="button"
                        >
                          {trace.root_span_name || trace.trace_id}
                        </button>
                        <span>{trace.root_service || "—"} · {services} {services === 1 ? "service" : "services"}</span>
                      </span>
                    );
                  },
                },
                {
                  header: "Duration",
                  key: "duration",
                  render: (trace) => (
                    <span className="traceRow__duration">
                      <span className={count(trace.error_count) > 0 ? "traceRow__durationTrack traceRow__durationTrack--error" : "traceRow__durationTrack"}>
                        <span style={{ width: `${Math.max(1, (trace.duration_ms / longest) * 100)}%` }} />
                      </span>
                      <span className="explorerCell--number">{formatDuration(trace.duration_ms)}</span>
                    </span>
                  ),
                  width: "180px",
                },
                {
                  align: "right",
                  header: "Spans",
                  key: "spans",
                  render: (trace) => <span className="explorerCell--number">{count(trace.span_count).toLocaleString()}</span>,
                  width: "72px",
                },
                {
                  header: "Status",
                  key: "status",
                  render: (trace) => count(trace.error_count) > 0
                    ? <span className="traceRow__status traceRow__status--error"><i aria-hidden="true" />Error</span>
                    : <span className="traceRow__status"><i aria-hidden="true" />OK</span>,
                  width: "104px",
                },
              ]}
              emptyMessage="No traces match these filters in this time range."
              getRowKey={(trace) => trace.trace_id}
              onRowClick={(trace) => onOpenTrace(trace.trace_id === openTrace ? null : trace.trace_id)}
              rows={rows}
              selectedRowKey={openTrace}
              variant="workspace"
            />
          )}
          </div>
          <nav className="logPagination" aria-label="Trace pagination">
            <span>{traces.data && !traces.isFetching ? `${rows.length ? page * 50 + 1 : 0}–${page * 50 + rows.length} traces` : "Loading traces…"}</span>
            <span>Page {page + 1}</span>
            <button className="dsButton dsButton--secondary dsButton--small" type="button" disabled={page === 0 || traces.isFetching || traces.data === null} onClick={() => { onOpenTrace(null); setPagination({ key, page: page - 1 }); }}><ArrowLeftIcon size={12} />Previous</button>
            <button className="dsButton dsButton--secondary dsButton--small" type="button" disabled={!hasNext || traces.isFetching || traces.data === null} onClick={() => { onOpenTrace(null); setPagination({ key, page: page + 1 }); }}>Next<ArrowRightIcon size={12} /></button>
          </nav>
        </div>
      </div>
      {openTrace ? (
        <TraceDrawer
          key={openTrace}
          listState={listState}
          onClose={() => onOpenTrace(null)}
          onFilter={(filter) => { addFilter(filter); onOpenTrace(null); }}
          traceId={openTrace}
        />
      ) : null}
    </>
  );
}

export function TracesPage() {
  useDocumentTitle("Trace search");
  const telemetry = useTelemetryAvailable();
  const [params, setParams] = useSearchParams();
  const query = traceSearchQuery(params);
  const openTrace = params.get("trace");
  const { changeTimeZone, timeZone, timeZonePreference } = useTimeZonePreference();
  const [now, setNow] = useState(() => Date.now());
  const [refresh, setRefresh] = useState(0);

  function setQuery(update: Partial<TraceSearchQuery>) {
    if (update.range) setNow(Date.now());
    navigate({ ...query, ...update }, openTrace);
  }

  function reload() {
    setNow(Date.now());
    setRefresh((count) => count + 1);
  }

  function navigate(next: TraceSearchQuery, trace: string | null) {
    const nextParams = traceExplorerParams(next);
    if (trace) nextParams.set("trace", trace);
    setParams(nextParams, { replace: true });
  }

  return (
    <AppShell active="traces" activePage="/traces/search" redesigned wide>
      <div className="explorer">
        <header className="workspaceHeading">
          <h1><NavigationIcon section="traces" />Trace search</h1>
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
        <TelemetryGate signal="Traces" skeleton={<ExplorerSkeleton label="Loading traces…" />} state={telemetry}>
          <TraceExplorer
            now={now}
            refresh={refresh}
            timeZone={timeZone}
            onOpenTrace={(trace) => navigate(query, trace)}
            openTrace={openTrace}
            query={query}
            setQuery={setQuery}
          />
        </TelemetryGate>
      </div>
    </AppShell>
  );
}
