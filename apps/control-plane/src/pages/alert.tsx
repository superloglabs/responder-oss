import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  alertForm,
  alertMetricChoice,
  alertMetricOptions,
  alertMetricValue,
  alertRequest,
  createAlert,
  deleteAlert,
  emptyAlertForm,
  fetchAlert,
  fetchAlertSlackChannels,
  updateAlert,
  type AlertForm,
  type TelemetryAlert,
  type TelemetryAlertEpisode,
  type TelemetryAlertSlackChannel,
} from "../alerts-api";
import { pickedMetricLabel } from "../metric-picker";
import { AppShell } from "../components/app-shell";
import { AlertFilters } from "../components/alert-filters";
import { AlertChart } from "../components/alert-chart";
import { useAlertPreview } from "../use-alert-preview";
import { DashboardDialog } from "../components/dashboard-dialog";
import { Button, IconButton, SegmentedControl, SelectField, Switch, TextField } from "../design-system";
import {
  aiGroupFields,
  aiMeasureFields,
  fetchAttributeKeys,
  fetchMetricNames,
  widgetAggregationLabels,
  type MetricName,
} from "../dashboards-api";
import {
  alertValueUnit,
  describeAlertCondition,
  type AlertValueUnit,
} from "../../../../packages/core/src/telemetry/alert-text";
import { fetchServices } from "../telemetry-api";
import { useDocumentTitle } from "../use-document-title";
import { useTelemetryAvailable } from "../use-telemetry-available";
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

// Logs and spans are counted, or summed up from a field.
const measures = (["count", "count_distinct", "sum", "avg", "min", "max", "p50", "p90", "p95", "p99"] as const).map((value) => ({
  label: widgetAggregationLabels[value],
  value,
}));

function formUnit(form: Pick<AlertForm, "aggregation" | "field" | "source">): AlertValueUnit {
  return alertValueUnit({ aggregation: form.aggregation, field: form.field || null, source: form.source });
}

function withCurrent<T extends { value: string }>(options: T[], value: string, label: string): Array<T | { label: string; value: string }> {
  return value && !options.some((option) => option.value === value) ? [{ label, value }, ...options] : options;
}

// The day up to now, which the editor lists metrics and attributes from.
function lastDayWindow(): { since: number; until: number } {
  const now = Date.now();
  return { since: now - 86_400_000, until: now };
}

export function AlertPage() {
  const { alertId } = useParams();
  const navigate = useNavigate();
  const telemetry = useTelemetryAvailable();
  // A new alert may start from a graph, such as one in the metrics explorer.
  const draft = (useLocation().state as { alertDraft?: Partial<AlertForm> } | null)?.alertDraft;
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
  const [hours, setHours] = useState(1);
  const [revision, setRevision] = useState(0);
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

  // A new alert starts from the draft, if any, once telemetry is readable.
  const form = edited ?? (!alertId && telemetry.available ? { ...emptyAlertForm(), ...draft } : null);

  const preview = useAlertPreview(form, hours, revision);

  useEffect(() => {
    let cancelled = false;
    fetchAlertSlackChannels()
      .then((loaded) => { if (!cancelled) setChannels(loaded); })
      .catch(() => { if (!cancelled) setChannels([]); });
    return () => { cancelled = true; };
  }, []);

  const hasForm = form !== null;
  const source = form?.source ?? "logs";
  useEffect(() => {
    if (!hasForm) return;
    let cancelled = false;
    const attributeSource = source === "metric" ? "metrics" : source;
    const lastDay = lastDayWindow();
    void Promise.all([
      source === "metric" ? fetchMetricNames(lastDay).catch(() => []) : Promise.resolve([]),
      fetchAttributeKeys(lastDay, attributeSource).catch(() => []),
      fetchServices("24h", source === "metric" ? "all" : source).catch(() => []),
    ]).then(([loadedMetrics, loadedKeys, loadedServices]) => {
      if (cancelled) return;
      setMetrics(loadedMetrics);
      setKeys(loadedKeys);
      setServices(loadedServices);
    });
    return () => { cancelled = true; };
  }, [hasForm, source]);

  const update = (change: Partial<AlertForm>) =>
    setForm((current) => {
      const base = current ?? form;
      return base ? { ...base, ...change } : current;
    });
  const groupOptions = [
    { label: "No grouping", value: "" },
    { label: "Service", value: "service" },
    ...(source === "traces" ? aiGroupFields : []),
    ...keys.filter((key) => key !== "service").map((key) => ({ label: key, value: key })),
  ];
  // Spans offer their duration and AI usage before their attributes.
  const fieldOptions = [
    ...(source === "traces"
      ? [{ label: "Duration", value: "duration" }, ...aiMeasureFields.map((field) => ({ ...field, description: "AI usage" }))]
      : []),
    ...keys.map((key) => ({ label: key, value: key })),
  ];

  async function save() {
    if (!form) return;
    const request = alertRequest({ ...form, enabled: saved ? form.enabled : true });
    if ("error" in request) {
      setError(request.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (saved) {
        const alert = await updateAlert(saved.alert.id, request.body);
        setSaved({ ...saved, alert });
        setForm(alertForm(alert));
        navigate(`/alerts/${alert.id}`);
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
        ) : telemetry.available === false && !alertId ? (
          <section className="emptyState emptyState--list">
            <h2>Alerts are not available</h2>
            <p>This workspace cannot read telemetry yet.</p>
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
  const metricOptions = alertMetricOptions(metrics);
  const metricValue = form?.metricName ? alertMetricValue(form) : "";

  return (
    <AppShell active="alerts" redesigned>
      <div className="alertPage alertPage--editor">
        <header className="alertHeader">
          <nav aria-label="Breadcrumb" className="alertBreadcrumb">
            <Link to="/alerts">Alerts</Link>
            <span aria-hidden="true">›</span>
            <span aria-current="page">{saved ? `Edit ${saved.alert.name}` : "Create alert"}</span>
          </nav>
          <div className="alertTitleRow">
            <h1>{saved ? `Edit ${saved.alert.name}` : "Create alert"}</h1>
            <span className="automationCreate__spacer" />
            <Button onClick={() => navigate(saved ? `/alerts/${saved.alert.id}` : "/alerts")} size="small" variant="secondary">Cancel</Button>
            {saved ? <Button onClick={() => setDeleting(true)} size="small" variant="ghost">Delete</Button> : null}
            <Button loading={saving} onClick={() => void save()} size="small" variant="primary">
              {saved ? "Save changes" : "Create alert"}
            </Button>
          </div>
          <p className="alertMuted">Define what matters, when to trigger, and who should know.</p>
        </header>
        {error ? <p className="formError" role="alert">{error}</p> : null}
          <form className="alertForm" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <TextField label="Alert name" maxLength={200} onChange={(event) => update({ name: event.target.value })} placeholder="Checkout errors" value={form.name} />

            <section className="alertForm__section">
              <div className="alertForm__intro"><h2>1. Explore your data</h2><p>Select a source and search criteria, then preview matching events over time.</p></div>
              <div className="alertForm__fields">
              <SelectField
                label="Data source"
                onChange={(value) =>
                  update({ aggregation: value === "metric" ? "avg" : "count", field: "", groupBy: "", perGroup: false, source: value })
                }
                options={[
                  { label: "Logs", value: "logs" },
                  { label: "Spans", value: "traces" },
                  { label: "Metric", value: "metric" },
                ]}
                value={form.source}
              />
              {form.source === "traces" ? (
                <Switch checked={form.spanErrors} label="Only spans with an error status" onCheckedChange={(spanErrors) => update({ spanErrors })} />
              ) : null}
              {form.source === "metric" ? (
                <div className="widgetEditor__row">
                  <SelectField
                    label="Metric"
                    onChange={(value) => update(value ? alertMetricChoice(value) : { metricKind: "", metricName: "", metricUnit: null })}
                    options={[
                      ...(form.metricName ? [] : [{ label: "Choose a metric", value: "" }]),
                      ...withCurrent(
                        metricOptions,
                        metricValue,
                        pickedMetricLabel({ kind: form.metricKind, name: form.metricName, unit: form.metricUnit }),
                      ),
                    ]}
                    searchable
                    value={metricValue}
                  />
                  <SegmentedControl
                    aria-label="Aggregation"
                    onChange={(aggregation) => update({ aggregation })}
                    options={[{ label: "Average", value: "avg" }, { label: "Sum", value: "sum" }]}
                    value={form.aggregation === "sum" ? "sum" : "avg"}
                  />
                </div>
              ) : null}
              <div className="widgetEditor__row">
              <SelectField
                label="Service"
                onChange={(service) => update({ service })}
                options={[{ label: "Any service", value: "" }, ...withCurrent(services.map((name) => ({ label: name, value: name })), form.service, form.service)]}
                searchable={services.length > 8}
                value={form.service}
              />
              {form.source === "logs" ? (
                <SelectField label="Severity" onChange={(severity) => update({ severity })} options={severities} value={form.severity} />
              ) : null}
              </div>
              <AlertFilters filters={form.filters} keys={keys} onChange={(filters) => update({ filters })} />
              <div className="alertSectionHeading"><span className="alertMuted">Matching data</span><div className="alertToolbar">
                <SelectField label="Preview time range" value={String(hours)} onChange={(value) => setHours(Number(value))} options={[{ label: "Last 1 hour", value: "1" }, { label: "Last 6 hours", value: "6" }, { label: "Last 24 hours", value: "24" }]} />
                <Button size="small" variant="primary" onClick={() => setRevision((value) => value + 1)} loading={preview.loading}>Run search</Button>
              </div></div>
              <section className="alertChart"><h3>Matching data</h3><AlertChart rule={form} chart={preview.data?.chart} error={preview.error} loading={preview.loading} showThreshold={false} /></section>
              </div>
            </section>

            <section className="alertForm__section">
              <div className="alertForm__intro"><h2>2. Set the threshold</h2><p>Choose when to trigger and compare the threshold with your data.</p></div>
              <div className="alertForm__fields">
              <div className="widgetEditor__row">
                <SelectField
                  label="Trigger when value is"
                  onChange={(comparator) => update({ comparator })}
                  options={[{ label: "Above", value: "gt" }, { label: "Below", value: "lt" }]}
                  value={form.comparator}
                />
                <TextField
                  className="alertForm__threshold"
                  inputMode="decimal"
                  label={formUnit(form) === "usd" ? "Threshold (USD)" : formUnit(form) === "ms" ? "Threshold (ms)" : "Threshold"}
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
                  Fires when the value is {describeAlertCondition(form.comparator, Number(form.threshold), formUnit(form))}, and recovers when it is not.
                </p>
              ) : null}
              <details className="alertAdvanced"><summary>Advanced settings</summary><div className="alertForm__fields">
              {form.source !== "metric" ? (
                <div className="widgetEditor__row">
                  <SelectField
                    label="Measure"
                    onChange={(aggregation) =>
                      // Error-only spans suit a count; other measures start from every span.
                      update(form.aggregation === "count" && aggregation !== "count" ? { aggregation, spanErrors: false } : { aggregation })
                    }
                    options={measures}
                    value={form.aggregation}
                  />
                  {form.aggregation !== "count" ? (
                    <SelectField
                      label="Field"
                      onChange={(field) => update({ field })}
                      options={[
                        ...(form.field ? [] : [{ label: "Choose a field", value: "" }]),
                        ...withCurrent(fieldOptions, form.field, form.field),
                      ]}
                      searchable={fieldOptions.length > 8}
                      value={form.field}
                    />
                  ) : null}
                </div>
              ) : null}
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
              </div></details>
              <section className="alertChart"><h3>Threshold preview</h3><AlertChart rule={form} chart={preview.data?.chart} error={preview.error} loading={preview.loading} /><p className="alertMuted">Each point covers {form.windowMinutes} {form.windowMinutes === 1 ? "minute" : "minutes"}. The dashed line is the threshold.</p></section>
              </div>
            </section>

            <section className="alertForm__section">
              <div className="alertForm__intro"><h2>3. Where to notify</h2><p>Choose where to send activation and recovery notifications.</p></div>
              <div className="alertForm__fields">
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
              </div>
            </section>
          </form>
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
