import { NavigationIcon } from "../components/navigation-icon";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AppShell } from "../components/app-shell";
import { DataTableSkeleton } from "../components/screen-skeletons";
import { MetricKindIcon } from "../components/metric-kind-icon";
import { SendTelemetryLink, TelemetryGate } from "../components/telemetry";
import { DataTable, SegmentedControl, SelectField } from "../design-system";
import {
  fetchMetricCatalog,
  filterMetricCatalog,
  groupMetricCatalog,
  metricCatalogGroup,
  metricDisplay,
  metricExplorerHref,
  metricKindLabel,
  metricKinds,
  type MetricCatalogEntry,
} from "../metrics-api";
import { fetchServices, telemetryRanges, type TelemetryRange } from "../telemetry-api";
import { useDocumentTitle } from "../use-document-title";
import { useTelemetryAvailable } from "../use-telemetry-available";
import "../components/automation-run-history.css";
import "../components/metrics.css";

const rangeValues = new Set<string>(telemetryRanges.map((range) => range.value));
// Dimension chips shown before the rest are counted.
const shownDimensions = 3;

function metricKey(metric: MetricCatalogEntry): string {
  return `${metric.kind}:${metric.name}:${metric.unit}`;
}

// Every metric the workspace sends, with its type, unit and dimensions. Filters
// live in the URL, so returning from a metric restores them.
export function MetricsPage() {
  useDocumentTitle("Metrics");
  const navigate = useNavigate();
  const telemetry = useTelemetryAvailable();
  const available = telemetry.available === true;
  const [params, setParams] = useSearchParams();
  const rangeParam = params.get("range") ?? "";
  const range: TelemetryRange = rangeValues.has(rangeParam) ? (rangeParam as TelemetryRange) : "1h";
  const kind = params.get("kind") ?? "";
  const service = params.get("service") ?? "";
  const search = params.get("q") ?? "";
  const [catalog, setCatalog] = useState<MetricCatalogEntry[] | null>(null);
  // Every service in the window. The catalog's own lists are sampled, so
  // they can miss a service.
  const [allServices, setAllServices] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  function setFilter(key: string, value: string) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  }

  const load = useCallback(async () => {
    if (!available) return;
    const generation = ++request.current;
    setCatalog(null);
    void fetchServices(range, "all")
      .catch(() => [])
      .then((loaded) => { if (request.current === generation) setAllServices(loaded); });
    try {
      const loaded = await fetchMetricCatalog(range);
      if (request.current !== generation) return;
      setCatalog(loaded);
      setError(null);
    } catch (cause) {
      if (request.current !== generation) return;
      setCatalog([]);
      setError(cause instanceof Error ? cause.message : "Unable to load metrics");
    }
  }, [available, range]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => { request.current += 1; };
  }, [load]);

  const services = useMemo(
    () =>
      [
        ...new Set([...allServices, ...(catalog ?? []).flatMap((metric) => metric.services), ...(service ? [service] : [])]),
      ].sort(),
    [allServices, catalog, service],
  );
  const shown = useMemo(
    () => filterMetricCatalog(catalog ?? [], { kind, search, service }),
    [catalog, kind, search, service],
  );
  const table = useMemo(() => groupMetricCatalog(shown), [shown]);
  const attributeKeys = new Set(shown.flatMap((metric) => metric.attributes)).size;

  return (
    <AppShell active="metrics" redesigned>
      <header className="workspaceHeading">
        <h1><NavigationIcon section="metrics" />Metrics</h1>
      </header>
      <TelemetryGate signal="Metrics" state={telemetry}>
        <section aria-label="Metrics" className="telemetryPage">
          <div className="telemetryPage__toolbar">
            <SelectField
              className="telemetryPage__select"
              label="Service"
              onChange={(value) => setFilter("service", value)}
              options={[{ label: "All services", value: "" }, ...services.map((name) => ({ label: name, value: name }))]}
              searchable={services.length > 8}
              value={service}
            />
            <SelectField
              className="telemetryPage__select"
              label="Type"
              onChange={(value) => setFilter("kind", value)}
              options={[
                { label: "All types", value: "" },
                ...metricKinds.map((value) => ({ label: metricKindLabel(value), value })),
              ]}
              value={kind}
            />
            <label className="telemetryPage__search">
              <MagnifyingGlassIcon aria-hidden="true" size={14} />
              <input
                aria-label="Search metrics"
                maxLength={200}
                onChange={(event) => setFilter("q", event.target.value)}
                placeholder="Search names, descriptions, units or attribute keys"
                type="search"
                value={search}
              />
            </label>
            <SegmentedControl
              aria-label="Time range"
              onChange={(value) => setFilter("range", value === "1h" ? "" : value)}
              options={telemetryRanges}
              value={range}
            />
          </div>
          {error ? (
            <div className="automationRuns__message" role="alert">
              <p>{error}</p>
              <button onClick={() => void load()} type="button">Retry</button>
            </div>
          ) : catalog === null ? (
            <DataTableSkeleton
              className="agentListTable telemetryPage__table"
              columns={[
                { cell: "twoLines", header: "Metric", key: "metric" },
                { header: "Type", key: "kind", width: "120px" },
                { header: "Unit", key: "unit", width: "104px" },
                { header: "Dimensions", key: "dimensions", width: "34%" },
                { align: "right", header: "Series", key: "series", width: "88px" },
              ]}
              label="Loading metrics…"
              rows={8}
            />
          ) : catalog.length === 0 ? (
            <section className="emptyState emptyState--list">
              <h2>No metrics in this time range</h2>
              <p>Metrics appear here once an application sends them to this workspace.</p>
              <SendTelemetryLink variant="primary" />
            </section>
          ) : (
            <>
              <p className="metricsCatalog__summary">
                <strong>
                  {shown.length === catalog.length
                    ? `${catalog.length} ${catalog.length === 1 ? "metric" : "metrics"}`
                    : `${shown.length} of ${catalog.length} metrics`}
                </strong>
                {attributeKeys > 0 ? <span>{attributeKeys} attribute keys</span> : null}
              </p>
              <div className="agentListTable telemetryPage__table">
                <DataTable<MetricCatalogEntry>
                  aria-label="Metrics"
                  columns={[
                    {
                      header: "Metric",
                      key: "metric",
                      render: (metric) => {
                        const display = metricDisplay(metric);
                        const friendly = display.title !== metric.name;
                        return (
                          <div className="metricName">
                            <MetricKindIcon kind={metric.kind} />
                            <span className="metricName__text">
                              <Link
                                className={friendly ? "metricName__name metricName__name--friendly" : "metricName__name"}
                                title={friendly ? metric.name : undefined}
                                to={metricExplorerHref(metric, { range })}
                              >
                                {display.title}
                              </Link>
                              {display.description ? <span className="metricName__description">{display.description}</span> : null}
                            </span>
                          </div>
                        );
                      },
                    },
                    {
                      header: "Type",
                      key: "kind",
                      render: (metric) => <span className="telemetryPage__number">{metricKindLabel(metric.kind)}</span>,
                      width: "120px",
                    },
                    {
                      header: "Unit",
                      key: "unit",
                      render: (metric) => <code className="metricUnit">{metric.unit || "—"}</code>,
                      width: "104px",
                    },
                    {
                      header: "Dimensions",
                      key: "dimensions",
                      render: (metric) =>
                        metric.attributes.length === 0 ? (
                          <span className="metricDimensions__none">{metric.series === null ? "—" : "None"}</span>
                        ) : (
                          <span className="metricDimensions">
                            {metric.attributes.slice(0, shownDimensions).map((attribute) => (
                              <code key={attribute}>{attribute}</code>
                            ))}
                            {metric.attributes.length > shownDimensions ? (
                              <span>+{metric.attributes.length - shownDimensions}</span>
                            ) : null}
                          </span>
                        ),
                      width: "34%",
                    },
                    {
                      align: "right",
                      header: "Series",
                      key: "series",
                      render: (metric) => (
                        <span className="telemetryPage__number">{metric.series === null ? "—" : metric.series.toLocaleString()}</span>
                      ),
                      width: "88px",
                    },
                  ]}
                  emptyMessage="No metrics match these filters."
                  getRowGroup={table.grouped ? metricCatalogGroup : undefined}
                  getRowKey={metricKey}
                  onRowClick={(metric) => navigate(metricExplorerHref(metric, { range }))}
                  rows={table.rows}
                  variant="workspace"
                />
              </div>
            </>
          )}
        </section>
      </TelemetryGate>
    </AppShell>
  );
}
