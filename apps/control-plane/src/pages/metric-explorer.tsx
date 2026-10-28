import {
  BellIcon,
  CaretDownIcon,
  CaretRightIcon,
  ChartBarIcon,
  ChartLineIcon,
  MagnifyingGlassIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { AppShell } from "../components/app-shell";
import { DashboardTimePicker } from "../components/dashboard-time-picker";
import { NavigationIcon } from "../components/navigation-icon";
import { ChartSkeleton, ListSkeleton } from "../components/screen-skeletons";
import { TelemetrySearch } from "../components/telemetry-search";
import { SendTelemetryLink, TelemetryGate } from "../components/telemetry";
import { seriesColors, TimeseriesChart } from "../components/timeseries-chart";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { resolveTimeRange, timeRangeFromParams, zoomOutTimeRange, type DashboardTimeRange } from "../dashboard-time-range";
import { Badge, Button, SelectField } from "../design-system";
import {
  addWidget,
  createDashboard,
  fetchDashboards,
  formatWidgetValue,
  type ChartData,
  type TelemetryDashboardSummary,
  type WidgetUnit,
} from "../dashboards-api";
import {
  dimensionLabel,
  fetchMetricCatalog,
  fetchMetricChart,
  fetchMetricDimensions,
  formatStep,
  groupMetrics,
  metricAggregationOptions,
  metricAlertDraft,
  metricChartTitle,
  metricDisplay,
  metricExplorerHref,
  metricKindLabel,
  metricLabel,
  metricQueryFromParams,
  metricQueryParams,
  metricRangeParams,
  metricWidgetDraft,
  metricWidgetUnit,
  searchMetrics,
  seriesStats,
  type MetricCatalogEntry,
  type MetricQuery,
} from "../metrics-api";
import { useOrganizationCapabilities } from "../organization-capabilities";
import { useDocumentTitle } from "../use-document-title";
import { useTelemetryAvailable } from "../use-telemetry-available";
import { useTimeZonePreference } from "../use-time-zone-preference";
import "../components/automation-run-history.css";
import "../components/metrics.css";
import "./automation-create.css";

// Loads `read` whenever `key` changes and drops answers to earlier keys.
function useLoaded<T>(key: string | null, read: () => Promise<T>) {
  const [state, setState] = useState<{ error: string | null; key: string | null; value: T | null }>({
    error: null,
    key: null,
    value: null,
  });
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(key);
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  });
  useEffect(() => {
    latest.current = key;
    if (key === null) return;
    readRef.current().then(
      (value) => { if (latest.current === key) setState({ error: null, key, value }); },
      (cause: unknown) => {
        if (latest.current === key) {
          setState({ error: cause instanceof Error ? cause.message : "Unable to load", key, value: null });
        }
      },
    );
  }, [key, attempt]);
  const current = state.key === key;
  return { error: current ? state.error : null, loading: !current, value: current ? state.value : null, retry: () => setAttempt(value => value + 1) };
}

function isSelected(metric: MetricCatalogEntry, selected: { kind: string; name: string; unit: string | null } | null): boolean {
  return selected !== null && metric.name === selected.name && metric.kind === selected.kind &&
    (selected.unit === null || metric.unit === selected.unit);
}

function MetricList({
  catalog,
  context,
  error,
  selected,
}: {
  catalog: MetricCatalogEntry[] | null;
  context: { range: DashboardTimeRange };
  error: string | null;
  selected: { kind: string; name: string; unit: string | null } | null;
}) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const selectedLink = useRef<HTMLAnchorElement>(null);
  const { kind, name, unit } = selected ?? { kind: null, name: null, unit: null };
  const groups = useMemo(() => {
    const current = kind === null || name === null ? null : { kind, name, unit };
    const grouped = groupMetrics(searchMetrics(catalog ?? [], search));
    const selectedIndex = grouped.findIndex(group => group.metrics.some(metric => isSelected(metric, current)));
    // Keep the current metric's namespace visible above the rest of the catalog.
    if (selectedIndex > 0) grouped.unshift(...grouped.splice(selectedIndex, 1));
    return grouped;
  }, [catalog, search, kind, name, unit]);
  useEffect(() => {
    selectedLink.current?.scrollIntoView({ block: "nearest" });
  }, [catalog, kind, name, unit]);
  return (
    <nav aria-label="Metrics" className="metricList">
      <label className="telemetryPage__search metricList__search">
        <MagnifyingGlassIcon aria-hidden="true" size={14} />
        <input
          aria-label="Find a metric"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search metrics"
          type="search"
          value={search}
        />
      </label>
      {error ? <p className="formError" role="alert">{error}</p> : null}
      {catalog === null && !error ? <ListSkeleton label="Loading metrics…" rows={8} /> : null}
      {catalog !== null && catalog.length > 0 && groups.length === 0 ? <p className="telemetryPage__status">No metrics match.</p> : null}
      <div className="metricList__groups">
        {groups.map((group) => {
          // A search shows every match.
          const selectedGroup = group.metrics.some(metric => isSelected(metric, selected));
          const open = Boolean(search.trim()) || (expanded[group.namespace] ?? selectedGroup);
          return (
            <section className="metricList__group" key={group.namespace}>
              <button
                aria-expanded={open}
                className="metricList__groupHeader"
                onClick={() => setExpanded(current => ({ ...current, [group.namespace]: !open }))}
                type="button"
              >
                <span className="metricList__groupName">{group.namespace}</span>
                <span className="metricList__count">{group.metrics.length}</span>
                {open ? <CaretDownIcon aria-hidden="true" size={12} /> : <CaretRightIcon aria-hidden="true" size={12} />}
              </button>
              {open ? (
                <ul>
                  {group.metrics.map((metric) => {
                    const current = isSelected(metric, selected);
                    const display = metricDisplay(metric);
                    const friendly = display.title !== metric.name;
                    const rest = friendly ? display.title : metric.name.slice(group.namespace.length + 1) || metric.name;
                    return (
                      <li key={`${metric.kind}:${metric.name}:${metric.unit}`}>
                        <Link
                          ref={current ? selectedLink : undefined}
                          aria-current={current ? "page" : undefined}
                          className="metricList__item"
                          title={metric.name}
                          to={metricExplorerHref(metric, context)}
                        >
                          <span className="metricList__name">{rest}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </section>
          );
        })}
      </div>
    </nav>
  );
}

function SeriesTable({
  chart,
  hidden,
  label,
  onToggle,
  unit,
}: {
  chart: ChartData;
  hidden: ReadonlySet<string>;
  label: string;
  onToggle: (name: string) => void;
  unit: WidgetUnit;
}) {
  if (chart.series.length === 0) return null;
  return (
    <table className="metricSeries">
      <thead>
        <tr>
          <th scope="col">{label}</th>
          <th scope="col">Avg</th>
          <th scope="col">Max</th>
          <th scope="col">Last</th>
        </tr>
      </thead>
      <tbody>
        {chart.series.map((series, index) => {
          const stats = seriesStats(series.values);
          return (
            <tr className={hidden.has(series.name) ? "metricSeries__row--hidden" : undefined} key={series.name}>
              <th scope="row">
                <button aria-pressed={!hidden.has(series.name)} onClick={() => onToggle(series.name)} type="button">
                  <span className={`timeseriesChart__swatch timeseriesChart__color--${index % seriesColors}`} />
                  <span className="metricSeries__name" title={series.name}>{label === "Series" ? "All services" : series.name}</span>
                </button>
              </th>
              <td>{formatWidgetValue(stats.average, unit)}</td>
              <td>{formatWidgetValue(stats.maximum, unit)}</td>
              <td>{formatWidgetValue(stats.last, unit)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function AddToDashboard({ query, unit }: { query: MetricQuery; unit: string }) {
  const navigate = useNavigate();
  const [dashboards, setDashboards] = useState<TelemetryDashboardSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function add(dashboardId: string | null) {
    setError(null);
    try {
      const target = dashboardId ?? (await createDashboard({ name: metricLabel(query.name) })).id;
      await addWidget(target, metricWidgetDraft(query, unit));
      navigate(`/dashboards/${encodeURIComponent(target)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to add the graph");
    }
  }

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open && dashboards === null) {
            fetchDashboards().then((loaded) => setDashboards(loaded ?? []), () => setDashboards([]));
          }
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button size="small" variant="primary"><PlusIcon size={12} />Add to dashboard</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Add this graph to</DropdownMenuLabel>
          {dashboards === null ? <DropdownMenuItem disabled>Loading…</DropdownMenuItem> : null}
          {(dashboards ?? []).map((dashboard) => (
            <DropdownMenuItem key={dashboard.id} onSelect={() => void add(dashboard.id)}>{dashboard.name}</DropdownMenuItem>
          ))}
          {dashboards && dashboards.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onSelect={() => void add(null)}>New dashboard</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error ? <p className="formError" role="alert">{error}</p> : null}
    </>
  );
}

function MetricTimePicker({
  now,
  onChange,
  range,
  zone: { changeTimeZone, timeZone, timeZonePreference },
}: {
  now: number;
  onChange: (range: DashboardTimeRange) => void;
  range: DashboardTimeRange;
  zone: ReturnType<typeof useTimeZonePreference>;
}) {
  return (
    <DashboardTimePicker
      now={now}
      onChange={onChange}
      onTimeZoneChange={changeTimeZone}
      onZoomOut={() => onChange(zoomOutTimeRange(range, Date.now(), null).range)}
      range={range}
      timeZone={timeZone}
      timeZonePreference={timeZonePreference}
      zoomed={false}
    />
  );
}

// Every metric the workspace sends, listed beside the graph of the one chosen.
// Without a metric in the URL, the page opens the first one listed.
export function MetricExplorerPage() {
  const telemetry = useTelemetryAvailable();
  const capabilities = useOrganizationCapabilities();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = metricQueryFromParams(params);
  const available = telemetry.available === true;
  useDocumentTitle(query ? `${metricLabel(query.name)} · Metrics` : "Metrics");
  const zone = useTimeZonePreference();
  const { timeZone } = zone;
  const [now, setNow] = useState(() => Date.now());
  const range = query?.range ?? timeRangeFromParams(params);
  const window = resolveTimeRange(range, now);
  const windowKey = [window.since, window.until];
  // Series hidden from the graph shown now; a new graph shows all its series.
  const [hiddenState, setHiddenState] = useState<{ key: string | null; names: Set<string> }>({
    key: null,
    names: new Set(),
  });

  const catalog = useLoaded(available ? JSON.stringify(windowKey) : null, () => fetchMetricCatalog(window));
  const dimensions = useLoaded(
    available && query ? JSON.stringify([windowKey, query.kind, query.name, query.unit]) : null,
    () => fetchMetricDimensions(window, query!),
  );
  const chartKey = available && query
    ? JSON.stringify([windowKey, query.kind, query.name, query.unit, query.aggregation, query.groupBy, query.filters])
    : null;
  const chart = useLoaded(chartKey, () => fetchMetricChart(query!, window));
  const hidden = hiddenState.key === chartKey ? hiddenState.names : new Set<string>();

  function changeRange(next: DashboardTimeRange) {
    setNow(Date.now());
    if (query) setParams(metricQueryParams({ ...query, range: next }), { replace: true });
    else setParams(metricRangeParams(next, params), { replace: true });
  }
  const timePicker = <MetricTimePicker now={now} onChange={(next) => changeRange(next)} range={range} zone={zone} />;
  const heading = <span className="metricExplorer__heading"><NavigationIcon section="metrics" />Metrics</span>;

  if (!query) {
    const first = catalog.value ? groupMetrics(catalog.value)[0]?.metrics[0] : undefined;
    if (first) return <Navigate replace to={metricExplorerHref(first, { range })} />;
    return (
      <AppShell active="metrics" redesigned wide>
        <TelemetryGate signal="Metrics" state={telemetry}>
          <div className="metricExplorer">
            <MetricList catalog={catalog.value} context={{ range }} error={catalog.error} selected={null} />
            <section aria-label="Metrics" className="metricExplorer__main">
              <div className="metricExplorer__topRow">
                {heading}
                <span className="automationCreate__spacer" />
                {timePicker}
              </div>
              {catalog.error ? (
                <div className="automationRuns__message" role="alert">
                  <p>{catalog.error}</p>
                  <button onClick={catalog.retry} type="button">Retry</button>
                </div>
              ) : catalog.value === null ? (
                <ChartSkeleton className="metricChart__plot" height="100%" label="Loading metrics…" />
              ) : (
                <section className="emptyState emptyState--list">
                  <h2>No metrics in this time range</h2>
                  <p>Metrics appear here once an application sends them to this workspace.</p>
                  <SendTelemetryLink variant="primary" />
                </section>
              )}
            </section>
          </div>
        </TelemetryGate>
      </AppShell>
    );
  }

  const metric = catalog.value?.find(
    (entry) => entry.name === query.name && entry.kind === query.kind && (query.unit === null || entry.unit === query.unit),
  );
  const unit = query.unit ?? metric?.unit ?? "";
  const label = metricLabel(query.name);
  const friendly = label !== query.name;
  const description = metricDisplay({ description: metric?.description ?? "", name: query.name }).description;
  const chartUnit = metricWidgetUnit({ kind: query.kind, unit }, query.aggregation);
  const context = { range: query.range };

  function update(change: Partial<MetricQuery>) {
    if (change.range) setNow(Date.now());
    setParams(metricQueryParams({ ...query!, ...change }), { replace: true });
  }
  const dimensionOptions = (dimensions.value ?? []).map((entry) => ({
    description: `${entry.scope === "point" ? "Data point" : "Resource"} · ${entry.cardinality} ${entry.cardinality === 1 ? "value" : "values"}`,
    label: entry.name,
    value: entry.key,
  }));
  const groupOptions = [
    { label: "No grouping", value: "" },
    // Keep a grouping from the URL listed before dimensions load.
    ...(query.groupBy && !dimensionOptions.some((option) => option.value === query.groupBy)
      ? [{ label: dimensionLabel(query.groupBy), value: query.groupBy }]
      : []),
    ...dimensionOptions,
  ];
  const seriesCount = chart.value?.series.length ?? 0;

  return (
    <AppShell active="metrics" redesigned wide>
      <TelemetryGate signal="Metrics" state={telemetry}>
        <div className="metricExplorer">
          <MetricList catalog={catalog.value} context={context} error={catalog.error} selected={query} />
          <section aria-label={query.name} className="metricExplorer__main">
            <header className="automationCreate__header">
              <div className="metricExplorer__topRow">
                {heading}
                <span className="automationCreate__spacer" />
                {timePicker}
                {capabilities.includes("alerts") ? (
                  <Button
                    onClick={() => navigate("/alerts/new", { state: { alertDraft: metricAlertDraft(query) } })}
                    size="small"
                  >
                    <BellIcon size={12} />Create alert
                  </Button>
                ) : null}
                {capabilities.includes("dashboards") ? <AddToDashboard query={query} unit={unit} /> : null}
              </div>
              <div className="metricExplorer__titleRow">
                <h1 title={friendly ? query.name : undefined}>{label}</h1>
                <Badge tone="neutral">{metricKindLabel(query.kind)}</Badge>
                {unit ? <Badge tone="neutral">{unit === "By" || unit === "B" ? "Bytes" : unit}</Badge> : null}
              </div>
              <p className="metricExplorer__meta">
                {friendly ? <><span>{query.name}</span>{" · "}</> : null}
                {[
                  description,
                  metric && metric.services.length > 0
                    ? `Reported by ${metric.services.length === 1 ? metric.services[0] : `${metric.services.length} services`}`
                    : null,
                  dimensions.value ? `${dimensions.value.length} ${dimensions.value.length === 1 ? "attribute" : "attributes"}` : null,
                ].filter(Boolean).join(" · ")}
              </p>
            </header>
            <TelemetrySearch
              signal="metrics"
              query={query}
              onChange={(next) => update({ filters: next.filters })}
              dataKey={JSON.stringify([windowKey, query.kind, query.name, query.unit])}
              attributeKeys={dimensions.value?.map(entry => entry.key) ?? null}
              keysError={dimensions.error}
              onRetryKeys={dimensions.retry}
              loadValues={async (key) => {
                const entries = dimensions.value ?? await fetchMetricDimensions(window!, query);
                return (entries.find(entry => entry.key === key)?.values ?? []).map(entry => ({ group: entry.value, value: entry.share }));
              }}
            />
            <div className="metricQuery">
              <div className="metricQuery__bar">
                <SelectField
                  className="dsField--compact metricQuery__select metricQuery__aggregation"
                  label="Aggregation"
                  onChange={(aggregation) => update({ aggregation })}
                  options={metricAggregationOptions(query.kind)}
                  value={query.aggregation}
                />
                <span className="metricQuery__word">Group by</span>
                <SelectField
                  className="dsField--compact metricQuery__select metricQuery__group"
                  label="Group by"
                  onChange={(groupBy) => update({ groupBy })}
                  options={groupOptions}
                  searchable={groupOptions.length > 8}
                  value={query.groupBy}
                />
              </div>
              <div aria-label="Chart type" className="dsSegmentedControl dsSegmentedControl--compact metricQuery__chartType" role="radiogroup">
                {([
                  { icon: ChartLineIcon, label: "Lines", value: "line" },
                  { icon: ChartBarIcon, label: "Bars", value: "bar" },
                ] as const).map((option) => (
                  <button
                    aria-checked={query.chartType === option.value}
                    className="dsSegmentedControl__option"
                    key={option.value}
                    onClick={() => update({ chartType: option.value })}
                    role="radio"
                    tabIndex={query.chartType === option.value ? 0 : -1}
                    onKeyDown={(event) => {
                      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                        event.preventDefault();
                        const next = event.key === "Home" ? "line" : event.key === "End" ? "bar" : query.chartType === "line" ? "bar" : "line";
                        update({ chartType: next });
                        const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button");
                        buttons?.[next === "line" ? 0 : 1]?.focus();
                      }
                    }}
                    type="button"
                  >
                    <option.icon aria-hidden="true" size={13} />{option.label}
                  </button>
                ))}
              </div>
            </div>
            <section aria-label="Graph" className="metricChart">
              <header>
                <h2>{metricChartTitle(query)}</h2>
                {chart.value ? (
                  <span>
                    {seriesCount} series{chart.value.stepMs ? ` · ${formatStep(chart.value.stepMs)} step` : ""}
                  </span>
                ) : null}
              </header>
              {chart.error ? (
                <div className="automationRuns__message" role="alert"><p>{chart.error}</p></div>
              ) : chart.value === null ? (
                <ChartSkeleton className="metricChart__plot" height="100%" label="Loading graph…" />
              ) : seriesCount === 0 ? (
                <p className="telemetryPage__status metricChart__plot">No data points match in this time range.</p>
              ) : (
                <>
                  <div className="metricChart__plot">
                    <TimeseriesChart
                      chart={chart.value}
                      chartType={query.chartType}
                      hiddenSeries={hidden}
                      label={metricChartTitle(query)}
                      onZoom={(since, until) => update({ range: { from: since, kind: "absolute", to: until } })}
                      showLegend={false}
                      timeZone={timeZone}
                      unit={chartUnit}
                    />
                  </div>
                  <SeriesTable
                    chart={chart.value}
                    hidden={hidden}
                    label={query.groupBy ? dimensionLabel(query.groupBy) : "Series"}
                    onToggle={(name) => {
                      const next = new Set(hidden);
                      if (next.has(name)) next.delete(name);
                      else next.add(name);
                      setHiddenState({ key: chartKey, names: next });
                    }}
                    unit={chartUnit}
                  />
                </>
              )}
            </section>
          </section>
        </div>
      </TelemetryGate>
    </AppShell>
  );
}
