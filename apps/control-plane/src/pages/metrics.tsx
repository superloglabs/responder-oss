import { ChartLineUpIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AppShell } from "../components/app-shell";
import { MetricKindIcon } from "../components/metric-kind-icon";
import { SendTelemetryLink, TelemetryProjectsGate } from "../components/telemetry";
import { DataTable, SegmentedControl, SelectField } from "../design-system";
import {
  fetchMetricCatalog,
  filterMetricCatalog,
  metricExplorerHref,
  metricKindLabel,
  metricKinds,
  type MetricCatalogEntry,
} from "../metrics-api";
import { telemetryRanges, type TelemetryRange } from "../telemetry-api";
import { useDocumentTitle } from "../use-document-title";
import { useTelemetryProjects } from "../use-telemetry-projects";
import "../components/automation-run-history.css";
import "../components/metrics.css";

const rangeValues = new Set<string>(telemetryRanges.map((range) => range.value));
// Dimension chips shown before the rest are counted.
const shownDimensions = 3;

function metricKey(metric: MetricCatalogEntry): string {
  return `${metric.kind}:${metric.name}:${metric.unit}`;
}

// Every metric a project sends, with its type, unit and dimensions. Filters
// live in the URL, so returning from a metric restores them.
export function MetricsPage() {
  useDocumentTitle("Metrics");
  const navigate = useNavigate();
  const telemetry = useTelemetryProjects();
  const [params, setParams] = useSearchParams();
  const projectId = params.get("projectId") || telemetry.projects?.[0]?.projectId || "";
  const rangeParam = params.get("range") ?? "";
  const range: TelemetryRange = rangeValues.has(rangeParam) ? (rangeParam as TelemetryRange) : "1h";
  const kind = params.get("kind") ?? "";
  const service = params.get("service") ?? "";
  const search = params.get("q") ?? "";
  const [catalog, setCatalog] = useState<MetricCatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  function setFilter(key: string, value: string) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(key, value);
      else next.delete(key);
      if (key === "projectId") next.delete("service");
      return next;
    }, { replace: true });
  }

  const load = useCallback(async () => {
    if (!projectId) return;
    const generation = ++request.current;
    setCatalog(null);
    try {
      const loaded = await fetchMetricCatalog(projectId, range);
      if (request.current !== generation) return;
      setCatalog(loaded);
      setError(null);
    } catch (cause) {
      if (request.current !== generation) return;
      setCatalog([]);
      setError(cause instanceof Error ? cause.message : "Unable to load metrics");
    }
  }, [projectId, range]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => { request.current += 1; };
  }, [load]);

  const services = useMemo(
    () => [...new Set([...(catalog ?? []).flatMap((metric) => metric.services), ...(service ? [service] : [])])].sort(),
    [catalog, service],
  );
  const shown = useMemo(
    () => filterMetricCatalog(catalog ?? [], { kind, search, service }),
    [catalog, kind, search, service],
  );
  const attributeKeys = new Set(shown.flatMap((metric) => metric.attributes)).size;

  return (
    <AppShell active="metrics" redesigned>
      <header className="workspaceHeading">
        <h1><ChartLineUpIcon aria-hidden="true" size={16} weight="bold" />Metrics</h1>
        {telemetry.projects && telemetry.projects.length > 0 ? (
          <div className="workspaceHeading__actions">
            <SendTelemetryLink variant="secondary" />
          </div>
        ) : null}
      </header>
      <TelemetryProjectsGate signal="Metrics" state={telemetry}>
        {(projects) => (
          <section aria-label="Metrics" className="telemetryPage">
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
              <p className="telemetryPage__status">Loading metrics…</p>
            ) : catalog.length === 0 ? (
              <section className="emptyState emptyState--list">
                <h2>No metrics in this time range</h2>
                <p>Metrics appear here once an application sends them to this project.</p>
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
                        render: (metric) => (
                          <div className="metricName">
                            <MetricKindIcon kind={metric.kind} />
                            <span className="metricName__text">
                              <Link className="metricName__name" to={metricExplorerHref(metric, { projectId, range })}>
                                {metric.name}
                              </Link>
                              {metric.description ? <span className="metricName__description">{metric.description}</span> : null}
                            </span>
                          </div>
                        ),
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
                    getRowKey={metricKey}
                    onRowClick={(metric) => navigate(metricExplorerHref(metric, { projectId, range }))}
                    rows={shown}
                    variant="workspace"
                  />
                </div>
              </>
            )}
          </section>
        )}
      </TelemetryProjectsGate>
    </AppShell>
  );
}
