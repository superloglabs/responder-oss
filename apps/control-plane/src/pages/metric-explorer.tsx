import {
  BellIcon,
  CaretDownIcon,
  CaretRightIcon,
  ChartBarIcon,
  ChartLineIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { AppShell } from "../components/app-shell";
import { MetricKindIcon } from "../components/metric-kind-icon";
import { TelemetryProjectsGate } from "../components/telemetry";
import { seriesColors, TimeseriesChart } from "../components/timeseries-chart";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Badge, Button, SegmentedControl, SelectField } from "../design-system";
import {
  addWidget,
  createDashboard,
  fetchDashboards,
  formatWidgetValue,
  type ChartData,
  type DashboardWidgetFilter,
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
  metricExplorerHref,
  metricKindLabel,
  metricQueryFromParams,
  metricQueryParams,
  metricWidgetDraft,
  metricWidgetUnit,
  maxMetricFilters,
  searchMetrics,
  seriesStats,
  type MetricCatalogEntry,
  type MetricDimension,
  type MetricQuery,
} from "../metrics-api";
import { useOrganizationCapabilities } from "../organization-capabilities";
import { telemetryRanges, type TelemetryRange } from "../telemetry-api";
import { useDocumentTitle } from "../use-document-title";
import { useTelemetryProjects } from "../use-telemetry-projects";
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
  }, [key]);
  const current = state.key === key;
  return { error: current ? state.error : null, loading: !current, value: current ? state.value : null };
}

function MetricList({
  catalog,
  context,
  error,
  selected,
}: {
  catalog: MetricCatalogEntry[] | null;
  context: { projectId: string; range: TelemetryRange };
  error: string | null;
  selected: { kind: string; name: string; unit: string | null };
}) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const groups = useMemo(() => groupMetrics(searchMetrics(catalog ?? [], search)), [catalog, search]);
  return (
    <nav aria-label="Metrics" className="metricList">
      <label className="telemetryPage__search metricList__search">
        <MagnifyingGlassIcon aria-hidden="true" size={14} />
        <input
          aria-label="Find a metric"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Find a metric or attribute"
          type="search"
          value={search}
        />
      </label>
      {error ? <p className="formError" role="alert">{error}</p> : null}
      {catalog === null && !error ? <p className="telemetryPage__status">Loading metrics…</p> : null}
      {catalog !== null && groups.length === 0 ? <p className="telemetryPage__status">No metrics match.</p> : null}
      {groups.map((group) => {
        // A search shows every match.
        const open = Boolean(search.trim()) || !collapsed.has(group.namespace);
        return (
          <section className="metricList__group" key={group.namespace}>
            <button
              aria-expanded={open}
              className="metricList__groupHeader"
              onClick={() =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(group.namespace)) next.delete(group.namespace);
                  else next.add(group.namespace);
                  return next;
                })
              }
              type="button"
            >
              {open ? <CaretDownIcon aria-hidden="true" size={12} /> : <CaretRightIcon aria-hidden="true" size={12} />}
              <span>{group.namespace}</span>
              <span className="metricList__count">{group.metrics.length}</span>
            </button>
            {open ? (
              <ul>
                {group.metrics.map((metric) => {
                  const current = metric.name === selected.name && metric.kind === selected.kind &&
                    (selected.unit === null || metric.unit === selected.unit);
                  const rest = metric.name.slice(group.namespace.length + 1) || metric.name;
                  return (
                    <li key={`${metric.kind}:${metric.name}:${metric.unit}`}>
                      <Link
                        aria-current={current ? "page" : undefined}
                        className="metricList__item"
                        title={metric.name}
                        to={metricExplorerHref(metric, context)}
                      >
                        <MetricKindIcon kind={metric.kind} />
                        <span className="metricList__name">{rest}</span>
                        <span className="metricList__unit">{metric.unit}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </section>
        );
      })}
    </nav>
  );
}

// Adds a filter inline, in the query bar, from an attribute and one of its
// values or a typed value.
function AddFilter({
  dimensions,
  onAdd,
}: {
  dimensions: MetricDimension[];
  onAdd: (filter: DashboardWidgetFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const dimension = dimensions.find((entry) => entry.key === key);

  function close() {
    setOpen(false);
    setKey("");
    setValue("");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!key || !value.trim()) return;
    onAdd({ key, value: value.trim() });
    close();
  }

  if (!open) {
    return (
      <button className="metricQuery__add" onClick={() => setOpen(true)} type="button">
        <PlusIcon aria-hidden="true" size={11} />Filter
      </button>
    );
  }
  return (
    <form className="metricQuery__filterForm" onKeyDown={(event) => { if (event.key === "Escape") close(); }} onSubmit={submit}>
      <SelectField
        className="metricQuery__select"
        label="Attribute"
        onChange={(next) => {
          setKey(next);
          setValue(dimensions.find((entry) => entry.key === next)?.values[0]?.value ?? "");
        }}
        options={[
          { label: "Attribute", value: "" },
          ...dimensions.map((entry) => ({
            description: `${entry.cardinality} ${entry.cardinality === 1 ? "value" : "values"}`,
            label: entry.name,
            value: entry.key,
          })),
        ]}
        searchable={dimensions.length > 8}
        value={key}
      />
      <span className="metricQuery__word">=</span>
      <input
        aria-label="Value"
        className="metricQuery__value"
        disabled={!key}
        list="metric-filter-values"
        maxLength={500}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Value"
        value={value}
      />
      <datalist id="metric-filter-values">
        {dimension?.values.map((entry) => <option key={entry.value} value={entry.value} />)}
      </datalist>
      <Button disabled={!key || !value.trim()} size="small" type="submit" variant="primary">Add</Button>
      <button aria-label="Cancel filter" className="metricQuery__cancel" onClick={close} type="button">
        <XIcon size={11} />
      </button>
    </form>
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
                  <span className="metricSeries__name" title={series.name}>{series.name}</span>
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

function DimensionsRail({
  dimensions,
  error,
  loading,
  onFilter,
  onGroup,
  query,
}: {
  dimensions: MetricDimension[] | null;
  error: string | null;
  loading: boolean;
  onFilter: (filter: DashboardWidgetFilter) => void;
  onGroup: (key: string) => void;
  query: MetricQuery;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const filtered = new Set(query.filters.map((filter) => filter.key));
  const sections = [
    { label: "Data point", rows: (dimensions ?? []).filter((entry) => entry.scope === "point") },
    { label: "Resource", rows: (dimensions ?? []).filter((entry) => entry.scope === "resource") },
  ].filter((section) => section.rows.length > 0);
  return (
    <aside aria-label="Dimensions" className="metricDimensionsRail">
      <header>
        <h2>Dimensions</h2>
        {dimensions ? <span>{dimensions.length}</span> : null}
      </header>
      <p className="metricDimensionsRail__hint">Attributes on this metric's points in the time range.</p>
      {loading ? <p className="telemetryPage__status">Loading…</p> : null}
      {error ? <p className="formError" role="alert">{error}</p> : null}
      {!loading && dimensions?.length === 0 ? <p className="telemetryPage__status">This metric has no attributes.</p> : null}
      {sections.map((section) => (
        <section className="metricDimensionsRail__section" key={section.label}>
          <h3>{section.label}</h3>
          {section.rows.map((dimension) => {
            const open = expanded === dimension.key;
            const grouped = query.groupBy === dimension.key;
            return (
              <div className={open ? "metricDimension metricDimension--open" : "metricDimension"} key={dimension.key}>
                <button
                  aria-expanded={open}
                  className="metricDimension__header"
                  onClick={() => setExpanded(open ? null : dimension.key)}
                  type="button"
                >
                  <code>{dimension.name}</code>
                  {grouped ? <Badge tone="info">Grouped</Badge> : null}
                  {filtered.has(dimension.key) ? <Badge tone="neutral">Filtered</Badge> : null}
                  <span className="metricDimension__count">{dimension.cardinality}</span>
                </button>
                {open ? (
                  <div className="metricDimension__body">
                    <ul aria-label={`Values of ${dimension.name}`}>
                      {dimension.values.map((entry) => (
                        <li key={entry.value}>
                          <button
                            onClick={() => onFilter({ key: dimension.key, value: entry.value })}
                            title={`Filter to ${entry.value}`}
                            type="button"
                          >
                            <span className="metricDimension__value">{entry.value || "(empty)"}</span>
                            <span className="metricDimension__share">{Math.round(entry.share * 100)}%</span>
                            <span className="metricDimension__bar" style={{ width: `${Math.max(2, entry.share * 100)}%` }} />
                          </button>
                        </li>
                      ))}
                    </ul>
                    <div className="metricDimension__actions">
                      <Button disabled={grouped} onClick={() => onGroup(dimension.key)} size="small">Group by</Button>
                      {dimension.cardinality > dimension.values.length ? (
                        <span>+{dimension.cardinality - dimension.values.length} more</span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </section>
      ))}
    </aside>
  );
}

function AddToDashboard({ query, unit }: { query: MetricQuery; unit: string }) {
  const navigate = useNavigate();
  const [dashboards, setDashboards] = useState<TelemetryDashboardSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function add(dashboardId: string | null) {
    setError(null);
    try {
      const target = dashboardId ?? (await createDashboard({ name: query.name, projectId: query.projectId })).id;
      await addWidget(target, metricWidgetDraft(query, unit));
      navigate(`/dashboards/${encodeURIComponent(target)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to add the graph");
    }
  }

  const ofProject = (dashboards ?? []).filter((dashboard) => dashboard.projectId === query.projectId);
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
          {ofProject.map((dashboard) => (
            <DropdownMenuItem key={dashboard.id} onSelect={() => void add(dashboard.id)}>{dashboard.name}</DropdownMenuItem>
          ))}
          {ofProject.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onSelect={() => void add(null)}>New dashboard</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error ? <p className="formError" role="alert">{error}</p> : null}
    </>
  );
}

export function MetricExplorerPage() {
  const telemetry = useTelemetryProjects();
  const capabilities = useOrganizationCapabilities();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const parsed = metricQueryFromParams(params);
  const projectId = parsed?.projectId || telemetry.projects?.[0]?.projectId || "";
  const query = parsed ? { ...parsed, projectId } : null;
  useDocumentTitle(query ? `${query.name} · Metrics` : "Metrics");
  // Series hidden from the graph shown now; a new graph shows all its series.
  const [hiddenState, setHiddenState] = useState<{ key: string | null; names: Set<string> }>({
    key: null,
    names: new Set(),
  });

  const catalog = useLoaded(projectId && query ? `${projectId}:${query.range}` : null, () =>
    fetchMetricCatalog(projectId, query!.range),
  );
  const dimensions = useLoaded(
    projectId && query ? JSON.stringify([projectId, query.range, query.kind, query.name, query.unit]) : null,
    () => fetchMetricDimensions(projectId, query!.range, query!),
  );
  const chartKey = projectId && query
    ? JSON.stringify([projectId, query.range, query.kind, query.name, query.unit, query.aggregation, query.groupBy, query.filters])
    : null;
  const chart = useLoaded(chartKey, () => fetchMetricChart(query!));
  const hidden = hiddenState.key === chartKey ? hiddenState.names : new Set<string>();

  if (!query) return <Navigate replace to="/metrics" />;

  const metric = catalog.value?.find(
    (entry) => entry.name === query.name && entry.kind === query.kind && (query.unit === null || entry.unit === query.unit),
  );
  const unit = query.unit ?? metric?.unit ?? "";
  const chartUnit = metricWidgetUnit({ kind: query.kind, unit }, query.aggregation);
  const context = { projectId, range: query.range };
  const catalogHref = `/metrics?${new URLSearchParams({
    ...(params.get("projectId") ? { projectId } : {}),
    ...(query.range !== "1h" ? { range: query.range } : {}),
  })}`.replace(/\?$/u, "");

  function update(change: Partial<MetricQuery>) {
    setParams(metricQueryParams({ ...query!, ...change }), { replace: true });
  }
  function addFilter(filter: DashboardWidgetFilter) {
    const filters = query!.filters.filter((existing) => existing.key !== filter.key);
    if (filters.length >= maxMetricFilters) return;
    update({ filters: [...filters, filter] });
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
    <AppShell active="metrics" density="wide" redesigned>
      <TelemetryProjectsGate signal="Metrics" state={telemetry}>
        {() => (
          <div className="metricExplorer">
            <MetricList catalog={catalog.value} context={context} error={catalog.error} selected={query} />
            <section aria-label={query.name} className="metricExplorer__main">
              <header className="automationCreate__header">
                <div className="metricExplorer__topRow">
                  <nav aria-label="Breadcrumb" className="automationCreate__breadcrumb">
                    <Link to={catalogHref}>Metrics</Link>
                    <span aria-hidden="true">›</span>
                    <span aria-current="page">{query.name}</span>
                  </nav>
                  <span className="automationCreate__spacer" />
                  <SegmentedControl
                    aria-label="Time range"
                    onChange={(range) => update({ range })}
                    options={telemetryRanges}
                    value={query.range}
                  />
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
                  <h1>{query.name}</h1>
                  <Badge tone="info">{metricKindLabel(query.kind)}</Badge>
                  {unit ? <Badge tone="neutral">{unit}</Badge> : null}
                </div>
                <p className="metricExplorer__meta">
                  {[
                    metric?.description,
                    metric && metric.services.length > 0
                      ? `Reported by ${metric.services.length === 1 ? metric.services[0] : `${metric.services.length} services`}`
                      : null,
                    dimensions.value ? `${dimensions.value.length} ${dimensions.value.length === 1 ? "attribute" : "attributes"}` : null,
                  ].filter(Boolean).join(" · ")}
                </p>
              </header>
              <div className="metricQuery">
                <div className="metricQuery__bar">
                  <SelectField
                    className="metricQuery__select metricQuery__aggregation"
                    label="Aggregation"
                    onChange={(aggregation) => update({ aggregation })}
                    options={metricAggregationOptions(query.kind)}
                    value={query.aggregation}
                  />
                  <span className="metricQuery__word">where</span>
                  {query.filters.map((filter) => (
                    <span className="metricQuery__chip" key={filter.key}>
                      <code>{dimensionLabel(filter.key)} {filter.op === "neq" ? "≠" : "="}</code>
                      <strong>{filter.value}</strong>
                      <button
                        aria-label={`Remove filter on ${dimensionLabel(filter.key)}`}
                        onClick={() => update({ filters: query.filters.filter((existing) => existing !== filter) })}
                        type="button"
                      >
                        <XIcon size={11} />
                      </button>
                    </span>
                  ))}
                  {query.filters.length < maxMetricFilters ? (
                    <AddFilter dimensions={dimensions.value ?? []} onAdd={addFilter} />
                  ) : null}
                  <span aria-hidden="true" className="metricQuery__divider" />
                  <span className="metricQuery__word">by</span>
                  <SelectField
                    className="metricQuery__select metricQuery__group"
                    label="Group by"
                    onChange={(groupBy) => update({ groupBy })}
                    options={groupOptions}
                    searchable={groupOptions.length > 8}
                    value={query.groupBy}
                  />
                </div>
                <div aria-label="Chart type" className="dsSegmentedControl metricQuery__chartType" role="radiogroup">
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
                  <p className="telemetryPage__status metricChart__plot">Loading…</p>
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
                        showLegend={false}
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
            <DimensionsRail
              dimensions={dimensions.value}
              error={dimensions.error}
              loading={dimensions.loading}
              onFilter={addFilter}
              onGroup={(groupBy) => update({ groupBy })}
              query={query}
            />
          </div>
        )}
      </TelemetryProjectsGate>
    </AppShell>
  );
}
