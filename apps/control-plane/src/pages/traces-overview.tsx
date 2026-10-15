import { TreeStructureIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AppShell } from "../components/app-shell";
import { CountHistogram, type HistogramSeries } from "../components/count-histogram";
import { TelemetryGate } from "../components/telemetry";
import { ExplorerTimeControls } from "../components/telemetry-explorer";
import { fetchAttributeValues } from "../dashboards-api";
import { DataTable, SelectField } from "../design-system";
import {
  environmentFilter,
  fetchServices,
  fetchTraceOverview,
  formatDuration,
  formatTelemetryTime,
  histogramBars,
  logTimestamp,
  traceExplorerParams,
  traceExplorerQuery,
  traceSearchHref,
  withEnvironment,
  telemetryRangeWindow,
  type TelemetryRange,
  type TraceExplorerQuery,
  type TraceOverview,
} from "../telemetry-api";
import { useDocumentTitle } from "../use-document-title";
import { useTelemetryAvailable } from "../use-telemetry-available";
import { useTelemetryQuery } from "../use-telemetry-query";
import "../components/automation-run-history.css";

type RequestSeries = "error" | "ok";

const requestChart: Array<HistogramSeries<RequestSeries>> = [
  { color: "#e07b73", label: "Errors", name: "error" },
  { color: "#c9c9c9", label: "Requests", name: "ok" },
];
const requestSeriesNames = requestChart.map((series) => series.name);

const rangeMinutes: Record<TelemetryRange, number> = { "15m": 15, "1h": 60, "6h": 360, "24h": 1_440, "7d": 10_080 };

function percent(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const value = (part / whole) * 100;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

// A line over the window, from each bucket's value.
function Sparkline({
  color,
  label,
  points,
  since,
  until,
}: {
  color: string;
  label: string;
  points: Array<{ at: number; value: number }>;
  since: number;
  until: number;
}) {
  const width = 300;
  const height = 40;
  const max = Math.max(...points.map((point) => point.value), 0) || 1;
  const span = until - since || 1;
  const coordinates = points.map((point) => [
    ((point.at - since) / span) * width,
    height - 2 - (point.value / max) * (height - 4),
  ] as const);
  const line = coordinates.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const first = coordinates[0];
  const last = coordinates.at(-1);
  return (
    <svg aria-label={label} className="overviewTile__chart" preserveAspectRatio="none" role="img" viewBox={`0 0 ${width} ${height}`}>
      {first && last ? (
        <>
          <polygon fill={color} fillOpacity={0.08} points={`${first[0]},${height} ${line} ${last[0]},${height}`} />
          <polyline fill="none" points={line} stroke={color} strokeLinejoin="round" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        </>
      ) : null}
    </svg>
  );
}

function OverviewBody({
  live,
  query,
  service,
  setQuery,
  setService,
}: {
  live: boolean;
  query: TraceExplorerQuery;
  service: string;
  setQuery: (update: Partial<TraceExplorerQuery>) => void;
  setService: (service: string) => void;
}) {
  const navigate = useNavigate();
  const key = `${traceExplorerParams(query)}|${service}`;
  const overview = useTelemetryQuery(
    key,
    () => fetchTraceOverview({ filters: query.filters, range: query.range, service }),
    live,
  );
  const services = useTelemetryQuery(query.range, () => fetchServices(query.range, "traces"));
  const environments = useTelemetryQuery(query.range, () =>
    fetchAttributeValues(telemetryRangeWindow(query.range), "traces", "resource.deployment.environment"),
  );
  const data: TraceOverview | null = overview.data?.overview ?? null;
  const since = overview.data ? Date.parse(overview.data.since) : 0;
  const until = overview.data ? Date.parse(overview.data.until) : 0;
  const bars = useMemo(() => {
    if (!overview.data) return null;
    return histogramBars(
      {
        buckets: overview.data.overview.series.flatMap((row) => [
          { bucket: row.bucket, count: row.errors, group: "error" },
          { bucket: row.bucket, count: Math.max(0, row.requests - row.errors), group: "ok" },
        ]),
        since: overview.data.since,
        stepMs: overview.data.stepMs,
        until: overview.data.until,
      },
      requestSeriesNames,
      (group) => (group === "error" ? "error" : "ok"),
    );
  }, [overview.data]);
  const points = (data?.series ?? []).flatMap((row) => {
    const at = logTimestamp(row.bucket)?.getTime();
    return at === undefined ? [] : [{ at, row }];
  });
  const minutes = rangeMinutes[query.range];
  const environment = environmentFilter(query.filters);
  const scope = (update: Partial<TraceExplorerQuery>) => {
    const params = traceExplorerParams({ ...query, ...(service ? { services: [service] } : {}), ...update });
    return traceSearchHref(params);
  };
  const maxDependency = Math.max(1, ...(data?.dependencies ?? []).map((dependency) => dependency.p95_ms));
  const serviceOptions = [...new Set([...(services.data ?? []), ...(service ? [service] : [])])].sort();
  const environmentOptions = [
    ...(environments.data ?? []),
    ...(environment && !environments.data?.includes(environment) ? [environment] : []),
  ];

  return (
    <>
      <div className="explorerToolbar">
        <SelectField
          className="explorerSelect"
          label="Service"
          onChange={setService}
          options={[{ label: "All services", value: "" }, ...serviceOptions.map((name) => ({ label: name, value: name }))]}
          searchable={serviceOptions.length > 8}
          value={service}
        />
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
      {overview.error ? (
        <div className="automationRuns__message" role="alert">
          <p>{overview.error}</p>
          <button onClick={overview.retry} type="button">Retry</button>
        </div>
      ) : null}
      <div className="overviewTiles">
        <section className="overviewTile">
          <h2>Requests</h2>
          <p className="overviewTile__value">
            {data ? Math.round(data.totals.requests / minutes).toLocaleString() : "…"}
            <span>per min</span>
          </p>
          <CountHistogram bars={bars} compact label="Requests over time, with errors" series={requestChart} />
        </section>
        <section className="overviewTile">
          <h2>Error rate</h2>
          <p className={data && data.totals.errors > 0 ? "overviewTile__value overviewTile__value--danger" : "overviewTile__value"}>
            {data ? percent(data.totals.errors, data.totals.requests) : "…"}
            <span>of {data ? data.totals.requests.toLocaleString() : "…"} requests</span>
          </p>
          <Sparkline
            color="#b33d43"
            label="Error rate over time"
            points={points.map(({ at, row }) => ({ at, value: row.requests ? row.errors / row.requests : 0 }))}
            since={since}
            until={until}
          />
        </section>
        <section className="overviewTile">
          <h2>p95 latency</h2>
          <p className="overviewTile__value">
            {data ? formatDuration(data.totals.p95_ms) : "…"}
          </p>
          <Sparkline
            color="#8a6d2b"
            label="p95 latency over time"
            points={points.map(({ at, row }) => ({ at, value: row.p95_ms }))}
            since={since}
            until={until}
          />
        </section>
      </div>
      <p className="overviewNote">Requests are spans that enter a service: server and consumer spans, and the root span of each trace.</p>
      <div className="overviewColumns">
        <div className="overviewColumn">
          <section className="overviewSection">
            <header><h2>Operations</h2></header>
            <div className="agentListTable explorerTableWrap">
              {data ? (
                <DataTable<TraceOverview["operations"][number]>
                  aria-label="Operations"
                  columns={[
                    { header: "Operation", key: "name", render: (row) => <span className="explorerCell--message" title={row.name}>{row.name}</span> },
                    { align: "right", header: "Req/min", key: "rate", render: (row) => <span className="explorerCell--number">{(row.requests / minutes).toLocaleString(undefined, { maximumFractionDigits: row.requests / minutes < 10 ? 1 : 0 })}</span>, width: "96px" },
                    {
                      align: "right",
                      header: "Errors",
                      key: "errors",
                      render: (row) => <span className={row.errors ? "explorerCell--number overviewDanger" : "explorerCell--number"}>{percent(row.errors, row.requests)}</span>,
                      width: "88px",
                    },
                    { align: "right", header: "p95", key: "p95", render: (row) => <span className="explorerCell--number">{formatDuration(row.p95_ms)}</span>, width: "96px" },
                  ]}
                  emptyMessage="No requests in this window."
                  getRowKey={(row) => row.name}
                  onRowClick={(row) => navigate(scope({ operations: [row.name] }))}
                  rows={data.operations}
                  variant="workspace"
                />
              ) : overview.error ? null : <p className="explorerStatus">Loading…</p>}
            </div>
          </section>
          <section className="overviewSection">
            <header><h2>Dependencies</h2></header>
            <div className="agentListTable explorerTableWrap">
              {data ? (
                <DataTable<TraceOverview["dependencies"][number]>
                  aria-label="Dependencies"
                  columns={[
                    { header: "Dependency", key: "name", render: (row) => <span className="explorerCell--message" title={row.name}>{row.name}</span>, width: "34%" },
                    {
                      header: "",
                      key: "bar",
                      render: (row) => (
                        <span className={row.errors ? "traceRow__durationTrack traceRow__durationTrack--error" : "traceRow__durationTrack overviewBar"}>
                          <span style={{ width: `${Math.max(1, (row.p95_ms / maxDependency) * 100)}%` }} />
                        </span>
                      ),
                    },
                    {
                      align: "right",
                      header: "p95",
                      key: "p95",
                      render: (row) => <span className={row.errors ? "explorerCell--number overviewDanger" : "explorerCell--number"}>{formatDuration(row.p95_ms)}</span>,
                      width: "96px",
                    },
                  ]}
                  emptyMessage="No outgoing calls in this window."
                  getRowKey={(row) => row.name}
                  rows={data.dependencies}
                  variant="workspace"
                />
              ) : overview.error ? null : <p className="explorerStatus">Loading…</p>}
            </div>
          </section>
        </div>
        <section className="overviewSection overviewColumn">
          <header>
            <h2>Top errors</h2>
            <Link to={scope({ statuses: ["STATUS_CODE_ERROR"] })}>View all in Search</Link>
          </header>
          <div className="agentListTable explorerTableWrap">
            {data ? (
              <DataTable<TraceOverview["errors"][number]>
                aria-label="Top errors"
                columns={[
                  {
                    header: "Error",
                    key: "message",
                    render: (row) => (
                      <span className="overviewError">
                        <span title={row.message}>{row.message}</span>
                        <small>{row.span_name} · {row.service}</small>
                      </span>
                    ),
                  },
                  { align: "right", header: "Traces", key: "traces", render: (row) => <span className="explorerCell--number overviewDanger">{row.traces.toLocaleString()}</span>, width: "88px" },
                  {
                    header: "First seen",
                    key: "first",
                    render: (row) => <span className="explorerCell--muted">{formatTelemetryTime(row.first_seen)}</span>,
                    width: "136px",
                  },
                ]}
                emptyMessage="No errors in this window."
                getRowKey={(row) => `${row.message}\u0000${row.service}\u0000${row.span_name}`}
                onRowClick={(row) => navigate(scope({ operations: [row.span_name], services: [row.service], statuses: ["STATUS_CODE_ERROR"] }))}
                rows={data.errors}
                variant="workspace"
              />
            ) : overview.error ? null : <p className="explorerStatus">Loading…</p>}
          </div>
        </section>
      </div>
    </>
  );
}

export function TracesOverviewPage() {
  useDocumentTitle("Traces overview");
  const telemetry = useTelemetryAvailable();
  const [params, setParams] = useSearchParams();
  const query = traceExplorerQuery(params);
  const service = query.services[0] ?? "";
  const [live, setLive] = useState(false);

  function navigate(next: TraceExplorerQuery) {
    setParams(traceExplorerParams(next), { replace: true });
  }

  return (
    <AppShell active="traces" activePage="/traces" redesigned wide>
      <div className="explorer">
        <header className="workspaceHeading">
          <h1><TreeStructureIcon aria-hidden="true" size={16} weight="bold" />Traces overview</h1>
          {telemetry.available ? (
            <div className="workspaceHeading__actions">
              <ExplorerTimeControls live={live} onLiveChange={setLive} onRangeChange={(range) => navigate({ ...query, range })} range={query.range} />
            </div>
          ) : null}
        </header>
        <TelemetryGate signal="Traces" state={telemetry}>
          <OverviewBody
            live={live}
            query={query}
            service={service}
            setQuery={(update) => navigate({ ...query, ...update })}
            setService={(value) => navigate({ ...query, services: value ? [value] : [] })}
          />
        </TelemetryGate>
      </div>
    </AppShell>
  );
}
