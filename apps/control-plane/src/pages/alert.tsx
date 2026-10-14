import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { relativeTime } from "../agents-api";
import {
  alertForm,
  alertRequest,
  createAlert,
  deleteAlert,
  emptyAlertForm,
  fetchAlert,
  fetchAlertSlackChannels,
  previewAlert,
  updateAlert,
  type AlertEvaluation,
  type AlertForm,
  type TelemetryAlert,
  type TelemetryAlertEpisode,
  type TelemetryAlertSlackChannel,
} from "../alerts-api";
import { AppShell } from "../components/app-shell";
import { AttributeFilters } from "../components/attribute-filters";
import { DashboardDialog } from "../components/dashboard-dialog";
import { TimeseriesChart } from "../components/timeseries-chart";
import { Badge, Button, IconButton, SegmentedControl, SelectField, Switch, TextField } from "../design-system";
import { fetchAttributeKeys, fetchMetricNames, type ChartData, type MetricName } from "../dashboards-api";
import { describeAlertCondition, formatAlertValue } from "../../../../packages/core/src/telemetry/alert-text";
import { fetchServices, formatDuration, formatTelemetryTime } from "../telemetry-api";
import { useDocumentTitle } from "../use-document-title";
import { useTelemetryProjects } from "../use-telemetry-projects";
import "../components/alerts.css";
import "../components/dashboards.css";
import "./automation-create.css";

const severities = [
  { label: "Any severity", value: "" },
  { label: "Fatal", value: "FATAL" },
  { label: "Error", value: "ERROR" },
  { label: "Warn", value: "WARN" },
  { label: "Info", value: "INFO" },
];

const windows = [
  { label: "1 minute", value: "1" },
  { label: "5 minutes", value: "5" },
  { label: "10 minutes", value: "10" },
  { label: "15 minutes", value: "15" },
  { label: "30 minutes", value: "30" },
  { label: "1 hour", value: "60" },
  { label: "6 hours", value: "360" },
  { label: "1 day", value: "1440" },
];

const intervals = [
  { label: "Every minute", value: "60" },
  { label: "Every 5 minutes", value: "300" },
  { label: "Every 15 minutes", value: "900" },
  { label: "Every hour", value: "3600" },
];

function withCurrent<T extends { value: string }>(options: T[], value: string, label: string): Array<T | { label: string; value: string }> {
  return value && !options.some((option) => option.value === value) ? [{ label, value }, ...options] : options;
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function AlertPreview({ form }: { form: AlertForm }) {
  // Preview the rule with a stand-in name, so it shows before one is typed.
  const request = alertRequest({ ...form, name: form.name || "Preview" });
  const key = "body" in request ? JSON.stringify(request.body) : null;
  const debouncedKey = useDebounced(key, 600);
  // The result and the rule it is for, so an older result is not shown
  // beside a newer rule.
  const [result, setResult] = useState<{
    key: string;
    value: { chart: ChartData; evaluations: AlertEvaluation[] } | { error: string };
  } | null>(null);
  const state = result && result.key === key ? result.value : null;

  useEffect(() => {
    if (!debouncedKey) return;
    let cancelled = false;
    previewAlert(JSON.parse(debouncedKey) as Parameters<typeof previewAlert>[0])
      .then((value) => { if (!cancelled) setResult({ key: debouncedKey, value }); })
      .catch((cause: unknown) => {
        if (!cancelled) setResult({ key: debouncedKey, value: { error: cause instanceof Error ? cause.message : "Unable to preview" } });
      });
    return () => { cancelled = true; };
  }, [debouncedKey]);

  const threshold = Number(form.threshold);
  return (
    <section aria-label="Preview" className="alertPreview">
      <h2>Preview</h2>
      {!key ? (
        <p className="dashboardWidget__status">{"error" in request ? request.error.replace(/^Name the alert\.$/u, "") : ""}</p>
      ) : !state ? (
        <p className="dashboardWidget__status">Loading…</p>
      ) : "error" in state ? (
        <p className="dashboardWidget__status" role="alert">{state.error}</p>
      ) : (
        <>
          <ul className="alertPreview__values">
            {state.evaluations.length === 0 ? <li className="dashboardWidget__status">No data in the last window.</li> : null}
            {state.evaluations.slice(0, 8).map((evaluation) => (
              <li key={evaluation.groupKey}>
                <span className="alertPreview__group">{evaluation.groupKey || (form.perGroup ? "(none)" : "Now")}</span>
                <strong>{formatAlertValue(evaluation.value)}</strong>
                <Badge tone={evaluation.breaching ? "danger" : "live"}>{evaluation.breaching ? "Would fire" : "OK"}</Badge>
              </li>
            ))}
          </ul>
          <div className="alertPreview__chart">
            {state.chart.series.length > 0 ? (
              <TimeseriesChart
                chart={state.chart}
                // Groups are compared with the threshold one by one, so they
                // are drawn as lines rather than stacked.
                chartType={form.source === "metric" || form.perGroup ? "line" : "bar"}
                label="Recent values"
                showLegend={state.chart.series.length > 1}
                {...(Number.isFinite(threshold) && form.threshold.trim() ? { threshold } : {})}
              />
            ) : (
              <p className="dashboardWidget__status">No data in the last {24} windows.</p>
            )}
          </div>
          <p className="dashboardDialog__hint">Each point is one window. The dashed line is the threshold.</p>
        </>
      )}
    </section>
  );
}

function Episodes({ episodes, perGroup }: { episodes: TelemetryAlertEpisode[]; perGroup: boolean }) {
  if (episodes.length === 0) return <p className="dashboardWidget__status">The alert has not fired yet.</p>;
  return (
    <table className="dashboardWidget__table alertEpisodes">
      <thead>
        <tr>
          <th scope="col">Started</th>
          {perGroup ? <th scope="col">Group</th> : null}
          <th scope="col">State</th>
          <th className="dashboardWidget__number" scope="col">Lasted</th>
          <th className="dashboardWidget__number" scope="col">Peak</th>
        </tr>
      </thead>
      <tbody>
        {episodes.map((episode) => (
          <tr key={episode.id}>
            <td className="dashboardWidget__muted" title={new Date(episode.startedAt).toLocaleString()}>{formatTelemetryTime(episode.startedAt)}</td>
            {perGroup ? <td className="dashboardWidget__mono">{episode.groupKey || "(none)"}</td> : null}
            <td>{episode.state === "firing" ? <Badge tone="danger">Firing</Badge> : <Badge>Recovered</Badge>}</td>
            <td className="dashboardWidget__number">
              {episode.endedAt ? formatDuration(Date.parse(episode.endedAt) - Date.parse(episode.startedAt)) : "—"}
            </td>
            <td className="dashboardWidget__number">{formatAlertValue(episode.peakValue)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AlertPage() {
  const { alertId } = useParams();
  const navigate = useNavigate();
  const telemetry = useTelemetryProjects();
  // What was loaded and edited, for the alert it belongs to. Moving to
  // another alert shows nothing of the previous one.
  const [loaded, setLoaded] = useState<{
    alertId: string | undefined;
    form: AlertForm | null;
    saved: { alert: TelemetryAlert; episodes: TelemetryAlertEpisode[] } | null;
  }>({ alertId, form: null, saved: null });
  const current = loaded.alertId === alertId ? loaded : { alertId, form: null, saved: null };
  const saved = current.saved;
  const edited = current.form;
  const setSaved = (next: { alert: TelemetryAlert; episodes: TelemetryAlertEpisode[] }) =>
    setLoaded((state) => (state.alertId === alertId ? { ...state, saved: next } : state));
  const setForm = (next: AlertForm | null | ((form: AlertForm | null) => AlertForm | null)) =>
    setLoaded((state) => {
      const base = state.alertId === alertId ? state : { alertId, form: null, saved: null };
      return { ...base, form: typeof next === "function" ? next(base.form) : next };
    });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [channels, setChannels] = useState<TelemetryAlertSlackChannel[] | null>(null);
  const [refreshingChannels, setRefreshingChannels] = useState(false);
  const [metrics, setMetrics] = useState<MetricName[]>([]);
  const [keys, setKeys] = useState<string[]>([]);
  const [services, setServices] = useState<string[]>([]);
  useDocumentTitle(saved ? `${saved.alert.name} · Alerts` : alertId ? "Alerts" : "New alert · Alerts");

  // The alert the page shows now, read when a load finishes.
  const latestAlertId = useRef(alertId);
  const load = useCallback(async () => {
    if (!alertId) return;
    setLoadError(null);
    try {
      const result = await fetchAlert(alertId);
      // A response for an alert the page has moved away from is dropped.
      if (latestAlertId.current !== alertId) return;
      setLoaded({ alertId, form: alertForm(result.alert), saved: result });
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Unable to load the alert");
    }
  }, [alertId]);

  useEffect(() => {
    latestAlertId.current = alertId;
    void Promise.resolve().then(load);
  }, [alertId, load]);

  // A new alert starts on the first linked project.
  const firstProjectId = telemetry.projects?.[0]?.projectId;
  const form = edited ?? (!alertId && firstProjectId ? emptyAlertForm(firstProjectId) : null);

  useEffect(() => {
    let cancelled = false;
    fetchAlertSlackChannels()
      .then((loaded) => { if (!cancelled) setChannels(loaded); })
      .catch(() => { if (!cancelled) setChannels([]); });
    return () => { cancelled = true; };
  }, []);

  const projectId = form?.projectId ?? "";
  const source = form?.source ?? "logs";
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const attributeSource = source === "metric" ? "metrics" : source;
    const now = Date.now();
    const lastDay = { since: now - 86_400_000, until: now };
    void Promise.all([
      source === "metric" ? fetchMetricNames(projectId, lastDay).catch(() => []) : Promise.resolve([]),
      fetchAttributeKeys(projectId, lastDay, attributeSource).catch(() => []),
      fetchServices(projectId, "24h", source === "metric" ? "all" : source).catch(() => []),
    ]).then(([loadedMetrics, loadedKeys, loadedServices]) => {
      if (cancelled) return;
      setMetrics(loadedMetrics);
      setKeys(loadedKeys);
      setServices(loadedServices);
    });
    return () => { cancelled = true; };
  }, [projectId, source]);

  const update = (change: Partial<AlertForm>) =>
    setForm((current) => {
      const base = current ?? form;
      return base ? { ...base, ...change } : current;
    });
  const groupOptions = useMemo(
    () => [
      { label: "No grouping", value: "" },
      { label: "Service", value: "service" },
      ...keys.filter((key) => key !== "service").map((key) => ({ label: key, value: key })),
    ],
    [keys],
  );

  async function save() {
    if (!form) return;
    const request = alertRequest(form);
    if ("error" in request) {
      setError(request.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (saved) {
        // The project of a saved alert does not change; the server ignores it.
        const alert = await updateAlert(saved.alert.id, request.body);
        setSaved({ ...saved, alert });
        setForm(alertForm(alert));
      } else {
        const alert = await createAlert(request.body);
        navigate(`/alerts/${alert.id}`, { replace: true });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the alert");
    } finally {
      setSaving(false);
    }
  }

  async function refreshChannels() {
    setRefreshingChannels(true);
    try {
      setChannels(await fetchAlertSlackChannels(true));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to refresh Slack channels");
    } finally {
      setRefreshingChannels(false);
    }
  }

  if (!form) {
    const problem = loadError ?? telemetry.error;
    return (
      <AppShell active="alerts" redesigned>
        {problem ? (
          <div className="automationRuns__message" role="alert">
            <p>{problem}</p>
            <button onClick={() => (loadError ? void load() : telemetry.retry())} type="button">Retry</button>
          </div>
        ) : telemetry.projects && telemetry.projects.length === 0 && !alertId ? (
          <section className="emptyState emptyState--list">
            <h2>No telemetry projects</h2>
            <p>Alerts need a telemetry project linked to this workspace.</p>
          </section>
        ) : (
          <p className="telemetryPage__status">Loading…</p>
        )}
      </AppShell>
    );
  }

  const slackOptions = [
    { label: "Don't post", value: "" },
    ...(channels ?? []).map((channel) => ({
      label: `#${channel.name}${new Set(channels?.map((item) => item.integrationAccountId)).size > 1 ? ` (${channel.accountName})` : ""}`,
      value: `${channel.integrationAccountId}:${channel.channelId}`,
    })),
  ];
  const metricOptions = metrics.map((metric) => ({ label: metric.unit ? `${metric.name} (${metric.unit})` : metric.name, value: metric.name }));
  const projects = telemetry.projects ?? [];

  return (
    <AppShell active="alerts" redesigned>
      <div className="alertPage">
        <header className="automationCreate__header">
          <nav aria-label="Breadcrumb" className="automationCreate__breadcrumb">
            <Link to="/alerts">Alerts</Link>
            <span aria-hidden="true">›</span>
            <span aria-current="page">{saved ? saved.alert.name : "New alert"}</span>
          </nav>
          <div className="dashboardPage__titleRow">
            <h1>{saved ? saved.alert.name : "New alert"}</h1>
            <span className="automationCreate__spacer" />
            {saved ? <Button onClick={() => setDeleting(true)} size="small" variant="ghost">Delete</Button> : null}
            <Button loading={saving} onClick={() => void save()} size="small" variant="primary">
              {saved ? "Save changes" : "Create alert"}
            </Button>
          </div>
          {saved?.alert.lastError ? (
            <p className="formError" role="alert">
              {saved.alert.lastError.startsWith("Posting to Slack failed")
                ? saved.alert.lastError
                : `The last check failed: ${saved.alert.lastError}`}
            </p>
          ) : saved?.alert.lastEvaluatedAt ? (
            <p className="dashboardPage__meta">Last checked {relativeTime(saved.alert.lastEvaluatedAt)}</p>
          ) : null}
        </header>
        {error ? <p className="formError" role="alert">{error}</p> : null}
        <div className="alertPage__body">
          <form className="alertForm" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <TextField label="Name" maxLength={200} onChange={(event) => update({ name: event.target.value })} placeholder="Checkout errors" value={form.name} />
            {!saved && projects.length > 1 ? (
              <SelectField
                label="Project"
                onChange={(value) => update({ filters: [], groupBy: "", metricName: "", perGroup: false, projectId: value, service: "" })}
                options={projects.map((project) => ({ label: project.name, value: project.projectId }))}
                value={form.projectId}
              />
            ) : null}

            <section className="alertForm__section">
              <h2>What to watch</h2>
              <SegmentedControl
                aria-label="Measure"
                onChange={(value) => update({ aggregation: value === "metric" ? "avg" : "count", groupBy: "", perGroup: false, source: value })}
                options={[
                  { label: "Log count", value: "logs" },
                  { label: "Span count", value: "traces" },
                  { label: "Metric", value: "metric" },
                ]}
                value={form.source}
              />
              {form.source === "logs" ? (
                <SelectField label="Severity" onChange={(severity) => update({ severity })} options={severities} value={form.severity} />
              ) : null}
              {form.source === "traces" ? (
                <Switch checked={form.spanErrors} label="Only spans with an error status" onCheckedChange={(spanErrors) => update({ spanErrors })} />
              ) : null}
              {form.source === "metric" ? (
                <div className="widgetEditor__row">
                  <SelectField
                    label="Metric"
                    onChange={(metricName) => update({ metricName })}
                    options={[
                      ...(form.metricName ? [] : [{ label: "Choose a metric", value: "" }]),
                      ...withCurrent(metricOptions, form.metricName, form.metricName),
                    ]}
                    searchable
                    value={form.metricName}
                  />
                  <SegmentedControl
                    aria-label="Aggregation"
                    onChange={(aggregation) => update({ aggregation })}
                    options={[{ label: "Average", value: "avg" }, { label: "Sum", value: "sum" }]}
                    value={form.aggregation === "sum" ? "sum" : "avg"}
                  />
                </div>
              ) : null}
              <SelectField
                label="Service"
                onChange={(service) => update({ service })}
                options={[{ label: "Any service", value: "" }, ...withCurrent(services.map((name) => ({ label: name, value: name })), form.service, form.service)]}
                searchable={services.length > 8}
                value={form.service}
              />
              <AttributeFilters filters={form.filters} keys={keys} onChange={(filters) => update({ filters })} />
              <div className="widgetEditor__row">
                <SelectField
                  label="Group by"
                  onChange={(groupBy) => update({ groupBy, perGroup: groupBy ? form.perGroup : false })}
                  options={withCurrent(groupOptions, form.groupBy, form.groupBy)}
                  searchable={groupOptions.length > 8}
                  value={form.groupBy}
                />
              </div>
              {form.groupBy ? (
                <Switch
                  checked={form.perGroup}
                  description="Each group fires and recovers on its own. Otherwise the groups are added up."
                  label="Alert for each group"
                  onCheckedChange={(perGroup) => update({ perGroup })}
                />
              ) : null}
            </section>

            <section className="alertForm__section">
              <h2>When to fire</h2>
              <div className="widgetEditor__row">
                <SegmentedControl
                  aria-label="Comparison"
                  onChange={(comparator) => update({ comparator })}
                  options={[{ label: "Above", value: "gt" }, { label: "Below", value: "lt" }]}
                  value={form.comparator}
                />
                <TextField
                  className="alertForm__threshold"
                  inputMode="decimal"
                  label="Threshold"
                  onChange={(event) => update({ threshold: event.target.value })}
                  value={form.threshold}
                />
              </div>
              <div className="widgetEditor__row">
                <SelectField label="Over the last" onChange={(value) => update({ windowMinutes: Number(value) })} options={withCurrent(windows, String(form.windowMinutes), `${form.windowMinutes} minutes`)} value={String(form.windowMinutes)} />
                <SelectField label="Check" onChange={(value) => update({ intervalSeconds: Number(value) })} options={withCurrent(intervals, String(form.intervalSeconds), `Every ${form.intervalSeconds} seconds`)} value={String(form.intervalSeconds)} />
              </div>
              {form.threshold.trim() && Number.isFinite(Number(form.threshold)) ? (
                <p className="dashboardDialog__hint">
                  Fires when the value is {describeAlertCondition(form.comparator, Number(form.threshold))}, and recovers when it is not.
                </p>
              ) : null}
            </section>

            <section className="alertForm__section">
              <h2>Where to post</h2>
              <div className="alertForm__slack">
                <SelectField
                  label="Slack channel"
                  onChange={(slack) => update({ slack })}
                  options={withCurrent(slackOptions, form.slack, "A channel that is no longer available")}
                  searchable={slackOptions.length > 8}
                  value={form.slack}
                />
                <IconButton aria-label="Refresh Slack channels" disabled={refreshingChannels} onClick={() => void refreshChannels()} size="small" variant="ghost">
                  <ArrowClockwiseIcon size={14} />
                </IconButton>
              </div>
              {channels && channels.length === 0 ? (
                <p className="dashboardDialog__hint">
                  Connect Slack in <Link to="/settings">Integrations</Link> to post alerts. Private channels appear once the Superlog app is in them.
                </p>
              ) : (
                <p className="dashboardDialog__hint">Posts when the alert fires, and replies in the thread when it recovers.</p>
              )}
              <Switch checked={form.enabled} label="Check this alert" onCheckedChange={(enabled) => update({ enabled })} />
            </section>
          </form>
          <AlertPreview form={form} />
        </div>
        {saved ? (
          <section aria-label="Recent episodes" className="alertForm__section alertPage__episodes">
            <h2>Recent episodes</h2>
            <Episodes episodes={saved.episodes} perGroup={saved.alert.groupMode === "per_group"} />
          </section>
        ) : null}
      </div>
      {deleting && saved ? (
        <DashboardDialog
          actions={
            <>
              <Button onClick={() => setDeleting(false)} variant="ghost">Cancel</Button>
              <Button
                onClick={() => {
                  void deleteAlert(saved.alert.id)
                    .then(() => navigate("/alerts"))
                    .catch((cause: unknown) => {
                      setError(cause instanceof Error ? cause.message : "Unable to delete the alert");
                      setDeleting(false);
                    });
                }}
                variant="danger"
              >
                Delete alert
              </Button>
            </>
          }
          onClose={() => setDeleting(false)}
          title={`Delete ${saved.alert.name}?`}
        >
          <p className="dashboardDialog__hint">The alert stops being checked and its history is deleted.</p>
        </DashboardDialog>
      ) : null}
    </AppShell>
  );
}
