import { TreeStructureIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AppShell } from "../components/app-shell";
import { CountHistogram, HistogramLegend, type HistogramSeries } from "../components/count-histogram";
import { TelemetryProjectsGate } from "../components/telemetry";
import {
  AddFacet,
  ExplorerFacet,
  ExplorerFilterBar,
  ExplorerTimeControls,
  type FilterChip,
} from "../components/telemetry-explorer";
import { TraceDrawer } from "../components/trace-drawer";
import { fetchAttributeKeys, fetchAttributeValues } from "../dashboards-api";
import { Badge, DataTable, SelectField } from "../design-system";
import {
  environmentFilter,
  explorerFilterText,
  fetchExplorerTraces,
  fetchTraceFacets,
  fetchTraceHistogram,
  formatDuration,
  formatExplorerTime,
  histogramBars,
  logTimestamp,
  parseExplorerFilter,
  telemetryRangeWindow,
  traceExplorerParams,
  traceExplorerQuery,
  withEnvironment,
  type ExplorerFilter,
  type TraceExplorerQuery,
  type TraceListState,
  type TraceSummary,
} from "../telemetry-api";
import { useDocumentTitle } from "../use-document-title";
import { useTelemetryProjects } from "../use-telemetry-projects";
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

function TraceExplorer({
  live,
  onOpenTrace,
  openTrace,
  projects,
  query,
  setQuery,
}: {
  live: boolean;
  onOpenTrace: (traceId: string | null) => void;
  openTrace: string | null;
  projects: Array<{ name: string; projectId: string }>;
  query: TraceExplorerQuery;
  setQuery: (update: Partial<TraceExplorerQuery>) => void;
}) {
  const key = traceExplorerParams(query).toString();
  const traces = useTelemetryQuery(key, () => fetchExplorerTraces(query), live);
  const histogram = useTelemetryQuery(key, () => fetchTraceHistogram(query), live);
  const facets = useTelemetryQuery(key, () => fetchTraceFacets(query), live);
  const keyQuery = `${query.projectId}|${query.range}`;
  const attributeKeys = useTelemetryQuery(keyQuery, () => fetchAttributeKeys(query.projectId, telemetryRangeWindow(query.range), "traces"));
  const environments = useTelemetryQuery(keyQuery, () =>
    fetchAttributeValues(query.projectId, telemetryRangeWindow(query.range), "traces", "resource.deployment.environment"),
  );
  const bars = useMemo(
    () => (histogram.data ? histogramBars(histogram.data, statusSeriesNames, statusSeries) : null),
    [histogram.data],
  );
  const total = bars?.reduce((sum, bar) => sum + bar.total, 0);
  const environment = environmentFilter(query.filters);
  const withDate = query.range === "7d" || query.range === "24h";
  const longest = Math.max(1, ...(traces.data ?? []).map((trace) => trace.duration_ms));
  const listState: TraceListState = { traceList: key };

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
      .filter((filter) => filter.value !== environment || filter.key !== "resource.deployment.environment")
      .map((filter) => ({
        id: `filter-${explorerFilterText(filter)}`,
        label: filterChipLabel(filter),
        onRemove: () => setQuery({ filters: query.filters.filter((item) => item !== filter) }),
        value: filter.value,
      })),
  ];
  const environmentOptions = [
    ...(environments.data ?? []),
    ...(environment && !environments.data?.includes(environment) ? [environment] : []),
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
        {projects.length > 1 ? (
          <SelectField
            className="explorerSelect"
            label="Project"
            onChange={(projectId) => setQuery({ facets: [], filters: [], operations: [], projectId, services: [] })}
            options={projects.map((project) => ({ label: project.name, value: project.projectId }))}
            value={query.projectId}
          />
        ) : null}
        {environmentOptions.length > 0 ? (
          <SelectField
            className="explorerSelect"
            label="Environment"
            onChange={(value) => setQuery({ filters: withEnvironment(query.filters, value) })}
            options={[{ label: "All environments", value: "" }, ...environmentOptions.map((value) => ({ label: value, value }))]}
            value={environment}
          />
        ) : null}
      </div>
      <section aria-label="Span volume" className="explorerVolume">
        <div className="explorerVolume__summary">
          <strong>{total === undefined ? "…" : `${total.toLocaleString()} ${total === 1 ? "span" : "spans"}`}</strong>
          <HistogramLegend bars={bars} series={statusChart} />
        </div>
        <CountHistogram bars={bars} label="Matching spans over time, by status" series={statusChart} />
      </section>
      {traces.error || histogram.error || facets.error ? (
        <div className="automationRuns__message" role="alert">
          <p>{traces.error ?? histogram.error ?? facets.error}</p>
          <button onClick={() => { traces.retry(); histogram.retry(); facets.retry(); }} type="button">Retry</button>
        </div>
      ) : null}
      <div className="explorerBody">
        <div aria-label="Trace filters" className="explorerFacets" role="group">
          <ExplorerFacet
            loading={!facets.data}
            onToggle={(value) => toggle("statuses", value)}
            options={[...(facets.data?.statuses ?? [])]
              .sort((a, b) => Object.keys(statusLabels).indexOf(a.group) - Object.keys(statusLabels).indexOf(b.group))
              .map((item) => ({ count: item.value, label: statusLabels[item.group] ?? item.group, value: item.group }))}
            selected={query.statuses}
            title="Status"
          />
          <ExplorerFacet
            loading={!facets.data}
            onToggle={(value) => toggle("services", value)}
            options={(facets.data?.services ?? []).filter((item) => item.group).map((item) => ({ count: item.value, label: item.group, value: item.group }))}
            selected={query.services}
            title="Service"
          />
          <ExplorerFacet
            loading={!facets.data}
            onToggle={(value) => toggle("operations", value)}
            options={(facets.data?.operations ?? []).filter((item) => item.group).map((item) => ({ count: item.value, label: item.group, value: item.group }))}
            selected={query.operations}
            title="Span name"
          />
          <ExplorerFacet
            loading={false}
            onToggle={(value) => setQuery({ minDurationMs: Number(value) === query.minDurationMs ? 0 : Number(value) })}
            options={durations}
            selected={query.minDurationMs > 0 ? [String(query.minDurationMs)] : []}
            title="Trace duration"
          />
          {query.facets.map((facetKey) => (
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
              options={(facets.data?.attributes[facetKey] ?? []).filter((item) => item.group).map((item) => ({ count: item.value, label: item.group, value: item.group }))}
              selected={query.filters.filter((filter) => filter.key === facetKey && filter.op === "eq").map((filter) => filter.value)}
              title={facetKey.replace(/^(span|resource)\./u, "")}
            />
          ))}
          <AddFacet
            keys={(attributeKeys.data ?? []).filter((item) => !query.facets.includes(item))}
            onAdd={(facetKey) => setQuery({ facets: [...query.facets, facetKey] })}
          />
        </div>
        <div className="agentListTable explorerTableWrap">
          {traces.data === null ? (
            traces.error ? null : <p className="explorerStatus">Loading traces…</p>
          ) : (
            <DataTable<TraceSummary>
              aria-label="Traces"
              columns={[
                {
                  header: "Started",
                  key: "time",
                  render: (trace) => (
                    <time className="explorerCell--muted" dateTime={logTimestamp(trace.start_time)?.toISOString()}>
                      {formatExplorerTime(trace.start_time, withDate)}
                    </time>
                  ),
                  width: withDate ? "176px" : "124px",
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
                  width: "26%",
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
                    ? <Badge tone="danger">{count(trace.error_count) === 1 ? "Error" : `${count(trace.error_count)} errors`}</Badge>
                    : <Badge tone="live">OK</Badge>,
                  width: "104px",
                },
              ]}
              emptyMessage="No traces match these filters in this time range."
              getRowKey={(trace) => trace.trace_id}
              onRowClick={(trace) => onOpenTrace(trace.trace_id === openTrace ? null : trace.trace_id)}
              rows={traces.data}
              selectedRowKey={openTrace}
              variant="workspace"
            />
          )}
          {(traces.data?.length ?? 0) >= 50 ? <p className="explorerMore">Showing the newest 50 traces. Narrow the filters to see others.</p> : null}
        </div>
      </div>
      {openTrace ? (
        <TraceDrawer
          key={openTrace}
          listState={listState}
          onClose={() => onOpenTrace(null)}
          onFilter={(filter) => { addFilter(filter); onOpenTrace(null); }}
          projectId={query.projectId}
          traceId={openTrace}
        />
      ) : null}
    </>
  );
}

export function TracesPage() {
  useDocumentTitle("Trace search");
  const telemetry = useTelemetryProjects();
  const [params, setParams] = useSearchParams();
  const query = traceExplorerQuery(params);
  const openTrace = params.get("trace");
  const [live, setLive] = useState(false);

  function navigate(next: TraceExplorerQuery, trace: string | null) {
    const nextParams = traceExplorerParams(next);
    if (trace) nextParams.set("trace", trace);
    setParams(nextParams, { replace: true });
  }

  return (
    <AppShell active="traces" activePage="/traces/search" redesigned wide>
      <div className="explorer">
        <header className="workspaceHeading">
          <h1><TreeStructureIcon aria-hidden="true" size={16} weight="bold" />Trace search</h1>
          {telemetry.projects && telemetry.projects.length > 0 ? (
            <div className="workspaceHeading__actions">
              <ExplorerTimeControls
                live={live}
                onLiveChange={setLive}
                onRangeChange={(range) => navigate({ ...query, range }, openTrace)}
                range={query.range}
              />
            </div>
          ) : null}
        </header>
        <TelemetryProjectsGate signal="Traces" state={telemetry}>
          {(projects) => {
            const resolved = {
              ...query,
              projectId: projects.some((project) => project.projectId === query.projectId) ? query.projectId : projects[0]!.projectId,
            };
            return (
              <TraceExplorer
                live={live}
                onOpenTrace={(trace) => navigate(resolved, trace)}
                openTrace={openTrace}
                projects={projects}
                query={resolved}
                // A trace ID from one project means nothing in another.
                setQuery={(update) => navigate(
                  { ...resolved, ...update },
                  update.projectId && update.projectId !== resolved.projectId ? null : openTrace,
                )}
              />
            );
          }}
        </TelemetryProjectsGate>
      </div>
    </AppShell>
  );
}
