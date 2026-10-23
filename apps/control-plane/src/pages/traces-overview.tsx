import { NavigationIcon } from "../components/navigation-icon";
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
const errorRateChart: Array<HistogramSeries<"value">> = [
  { color: "#e07b73", formatValue: (value) => `${value.toFixed(1)}%`, label: "Error rate", name: "value" },
];
const latencyChart: Array<HistogramSeries<"value">> = [
  {
    color: "#d4b54f",
    // Fixed millisecond thresholds keep colors consistent across time windows.
    colorForValue: (milliseconds) => milliseconds >= 1_000 ? "#e07b73" : milliseconds >= 500 ? "#d99a48" : "#d4b54f",
    formatValue: formatDuration,
    label: "p95 latency",
    name: "value",
  },
];
const requestSeriesNames = requestChart.map((series) => series.name);

const rangeMinutes: Record<TelemetryRange, number> = { "15m": 15, "1h": 60, "6h": 360, "24h": 1_440, "7d": 10_080 };

function percent(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const value = (part / whole) * 100;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
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
  const metricBars = useMemo(() => {
    const response = overview.data;
    if (!response) return null;
    const makeBars = (value: (row: TraceOverview["series"][number]) => number) => histogramBars(
      {
        buckets: response.overview.series.map((row) => ({ bucket: row.bucket, count: value(row), group: "value" })),
        since: response.since,
        stepMs: response.stepMs,
        until: response.until,
      },
      ["value"],
      () => "value",
    );
    return {
      errorRate: makeBars((row) => row.requests ? (row.errors / row.requests) * 100 : 0),
      latency: makeBars((row) => row.p95_ms),
    };
  }, [overview.data]);
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
          <CountHistogram
            bars={metricBars?.errorRate ?? null}
            compact
            label="Error rate over time"
            series={errorRateChart}
          />
        </section>
        <section className="overviewTile">
          <h2>p95 latency</h2>
          <p className="overviewTile__value">
            {data ? formatDuration(data.totals.p95_ms) : "…"}
          </p>
          <CountHistogram
            bars={metricBars?.latency ?? null}
            compact
            label="p95 latency over time"
            series={latencyChart}
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
          <h1><NavigationIcon section="traces" />Traces overview</h1>
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
