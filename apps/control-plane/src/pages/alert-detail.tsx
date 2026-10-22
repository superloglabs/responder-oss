import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  alertForm,
  alertRequest,
  fetchAlert,
  fetchAlertActivation,
  fetchAlertActivationChart,
  fetchAlertHistory,
  fetchAlertSlackChannels,
  updateAlert,
  type TelemetryAlert,
  type TelemetryAlertActivation,
  type TelemetryAlertEpisode,
} from "../alerts-api";
import {
  alertValueUnit,
  describeAlertCondition,
  describeAlertRule,
  formatAlertValue,
} from "../../../../packages/core/src/telemetry/alert-text";
import { AppShell } from "../components/app-shell";
import { AlertChart } from "../components/alert-chart";
import { useAlertPreview } from "../use-alert-preview";
import { Button } from "../design-system";
import { useDocumentTitle } from "../use-document-title";
import { formatDuration } from "../telemetry-api";
import "../components/alerts.css";

function useResource<T>(key: string, loader: () => Promise<T>) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; attempt: number; data?: T; error?: string } | null>(null);
  useEffect(() => {
    let active = true;
    void loader().then(
      (data) => {
        if (active) setResult({ key, attempt, data });
      },
      (cause: unknown) => {
        if (active) setResult({ key, attempt, error: cause instanceof Error ? cause.message : "Unable to load" });
      },
    );
    return () => {
      active = false;
    };
  }, [key, attempt, loader]);
  const current = result?.key === key && result.attempt === attempt ? result : null;
  return { data: current?.data, error: current?.error, retry: () => setAttempt((value) => value + 1) };
}

function time(value: string, seconds = false) {
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  });
}
function duration(episode: TelemetryAlertEpisode) {
  return episode.endedAt ? formatDuration(Date.parse(episode.endedAt) - Date.parse(episode.startedAt)) : "Ongoing";
}
function stateLabel(episode: TelemetryAlertEpisode) {
  return episode.state === "firing" ? "Firing" : episode.endReason === "recovered" ? "Recovered" : "Ended";
}
function dateLabel(date: string) {
  const day = new Date(date).toDateString();
  const today = new Date();
  if (day === today.toDateString()) return "Today";
  today.setDate(today.getDate() - 1);
  if (day === today.toDateString()) return "Yesterday";
  return new Date(date).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}
function interval(seconds: number) {
  return seconds === 60 ? "Every minute" : seconds < 60 ? `Every ${seconds} seconds` : `Every ${seconds / 60} minutes`;
}
function Properties({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <aside className="alertProperties">
      <h2>Properties</h2>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
function Header({
  alert,
  activation,
  children,
}: {
  alert: TelemetryAlert;
  activation?: TelemetryAlertActivation;
  children: ReactNode;
}) {
  const title = activation ? `Activation #${activation.id.slice(0, 8)}` : alert.name;
  return (
    <header className="alertHeader">
      <nav aria-label="Breadcrumb" className="alertBreadcrumb">
        <Link to="/alerts">Alerts</Link>
        <span aria-hidden="true">›</span>
        {activation ? (
          <>
            <Link to={`/alerts/${alert.id}`}>{alert.name}</Link>
            <span aria-hidden="true">›</span>
          </>
        ) : null}
        <span aria-current="page">{title}</span>
      </nav>
      <div className="alertTitleRow">
        <h1>{title}</h1>
        {children}
      </div>
    </header>
  );
}
function LoadState({ error, retry }: { error?: string; retry: () => void }) {
  return (
    <div className="alertEmpty" role={error ? "alert" : "status"}>
      {error ? (
        <>
          <p>{error}</p>
          <Button onClick={retry} size="small">
            Retry
          </Button>
        </>
      ) : (
        "Loading…"
      )}
    </div>
  );
}
function Filters({ alert }: { alert: Pick<TelemetryAlert, "filter"> }) {
  const filters = [
    ...(alert.filter.service ? [`service is ${alert.filter.service}`] : []),
    ...(alert.filter.severity ? [`severity is ${alert.filter.severity}`] : []),
    ...(alert.filter.statusCode ? [`status is ${alert.filter.statusCode}`] : []),
    ...(alert.filter.spanName ? [`span name is ${alert.filter.spanName}`] : []),
    ...(alert.filter.minDurationMs !== undefined ? [`duration ≥ ${alert.filter.minDurationMs} ms`] : []),
    ...(alert.filter.resourceAttrs ?? []).map(
      (filter) =>
        `${filter.key} ${filter.op === "neq" ? "is not" : filter.op === "not_contains" ? "does not contain" : "is"} ${filter.value}`,
    ),
  ];
  return filters.length ? (
    <div className="alertFilterSummary">
      {filters.map((filter, index) => (
        <span key={index}>{filter}</span>
      ))}
    </div>
  ) : null;
}
function History({ alert }: { alert: TelemetryAlert }) {
  const [state, setState] = useState("all");
  const [days, setDays] = useState("7");
  const [offset, setOffset] = useState(0);
  const loader = useCallback(() => fetchAlertHistory(alert.id, state, days, offset), [alert.id, state, days, offset]);
  const result = useResource(`${alert.id}/${state}/${days}/${offset}`, loader);
  const grouped = new Map<string, TelemetryAlertEpisode[]>();
  for (const episode of result.data?.episodes ?? []) {
    const label = dateLabel(episode.startedAt);
    grouped.set(label, [...(grouped.get(label) ?? []), episode]);
  }
  return (
    <section className="alertHistory">
      <div className="alertSectionHeading">
        <h2>Activation history</h2>
        <div className="alertToolbar">
          <select
            aria-label="Activation state"
            value={state}
            onChange={(event) => {
              setState(event.target.value);
              setOffset(0);
            }}
          >
            <option value="all">All states</option>
            <option value="firing">Firing</option>
            <option value="resolved">Ended</option>
          </select>
          <select
            aria-label="History time range"
            value={days}
            onChange={(event) => {
              setDays(event.target.value);
              setOffset(0);
            }}
          >
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="all">All time</option>
          </select>
        </div>
      </div>
      {!result.data ? (
        <LoadState error={result.error} retry={result.retry} />
      ) : !result.data.episodes.length ? (
        <p className="alertEmpty">No activations in this time range.</p>
      ) : (
        <div className="alertHistory__groups">
          {Array.from(grouped, ([label, episodes]) => (
            <div className="alertHistory__group" key={label}>
              <h3>{label}</h3>
              <div className="alertTableWrap">
                <table className="alertTable">
                  <colgroup>
                    <col className="alertTable__wide" />
                    <col />
                    <col />
                  </colgroup>
                  <thead>
                    <tr>
                      <th scope="col">Activation</th>
                      <th scope="col">State</th>
                      <th scope="col">Triggered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {episodes.map((episode) => (
                      <tr key={episode.id}>
                        <td>
                          <Link to={`/alerts/${alert.id}/activations/${episode.id}`}>
                            #{episode.id.slice(0, 8)}
                            {episode.groupKey ? ` · ${episode.groupKey}` : ""} · {duration(episode)} · Peak{" "}
                            {formatAlertValue(
                              episode.peakValue,
                              episode.ruleSnapshot ? alertValueUnit(episode.ruleSnapshot) : "none",
                            )}
                          </Link>
                        </td>
                        <td>
                          <span className={episode.state === "firing" ? "alertFiring" : ""}>{stateLabel(episode)}</span>
                        </td>
                        <td>
                          <time dateTime={episode.startedAt} title={new Date(episode.startedAt).toLocaleString()}>
                            {time(episode.startedAt)}
                          </time>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
      {offset > 0 || result.data?.hasMore ? (
        <div className="alertPagination">
          <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))} size="small">
            Previous
          </Button>
          <span>
            {offset + 1}–{offset + (result.data?.episodes.length ?? 0)}
          </span>
          <Button disabled={!result.data?.hasMore} onClick={() => setOffset(offset + 50)} size="small">
            Next
          </Button>
        </div>
      ) : null}
    </section>
  );
}
function AlertDetail({
  alert,
  episodes,
  reload,
}: {
  alert: TelemetryAlert;
  episodes: TelemetryAlertEpisode[];
  reload: () => void;
}) {
  const navigate = useNavigate();
  const [hours, setHours] = useState(1);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useAlertPreview(alertForm(alert), hours, revision);
  const channels = useResource(
    "slack",
    useCallback(() => fetchAlertSlackChannels(), []),
  );
  const channel = channels.data?.find(
    (channel) =>
      channel.channelId === alert.slack?.channelId && channel.integrationAccountId === alert.slack.integrationAccountId,
  );
  const unit = alertValueUnit(alert);
  useDocumentTitle(`${alert.name} · Alerts`);
  async function toggle() {
    const request = alertRequest({ ...alertForm(alert), enabled: !alert.enabled });
    if (!("body" in request)) return;
    setSaving(true);
    setError(null);
    try {
      await updateAlert(alert.id, request.body);
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update alert");
    } finally {
      setSaving(false);
    }
  }
  const evaluations = preview.data?.evaluations ?? [];
  const firing = episodes.filter((episode) => episode.state === "firing").length;
  return (
    <div className="alertPage">
      <Header alert={alert}>
        <Button size="small" loading={saving} onClick={() => void toggle()}>
          {alert.enabled ? "Pause alert" : "Resume alert"}
        </Button>
        <Button size="small" onClick={() => navigate(`/alerts/${alert.id}/edit`)}>
          Edit alert
        </Button>
      </Header>
      {error || alert.lastError ? (
        <p className="formError" role="alert">
          {error ?? alert.lastError}
        </p>
      ) : null}
      <div className="alertOverview">
        <div className="alertOverview__copy">
          <p>
            {describeAlertRule(alert)}. Activates when the value is{" "}
            {describeAlertCondition(alert.comparator, alert.threshold, unit)}
            {alert.slack ? ` and notifies ${channel ? `#${channel.name}` : `Slack ${alert.slack.channelId}`}` : ""}.
          </p>
          <section>
            <h2>Current evaluation</h2>
            <p>
              {preview.loading
                ? "Checking the current value…"
                : preview.error
                  ? preview.error
                  : evaluations.length === 0
                    ? "No data in the latest evaluation window."
                    : evaluations
                        .slice(0, 3)
                        .map(
                          (value) =>
                            `${value.groupKey ? `${value.groupKey}: ` : ""}${formatAlertValue(value.value, unit)} (${value.breaching ? "threshold breached" : "within threshold"})`,
                        )
                        .join(" · ")}
              {evaluations.length > 3 ? ` · ${evaluations.length - 3} more groups` : ""}
              {!alert.enabled ? " This alert is paused." : ""}
            </p>
          </section>
          <Filters alert={alert} />
        </div>
        <Properties
          rows={[
            ["State", alert.enabled ? "Enabled" : "Paused"],
            [
              "Health",
              alert.lastError
                ? "Check failed"
                : !alert.enabled
                  ? "Paused"
                  : firing
                    ? "Firing"
                    : alert.lastEvaluatedAt
                      ? "Healthy"
                      : "Awaiting check",
            ],
            ["Interval", interval(alert.evaluationIntervalSeconds)],
          ]}
        />
      </div>
      <section className="alertChart">
        <div className="alertSectionHeading">
          <h2>Evaluations</h2>
          <div className="alertToolbar">
            <select
              aria-label="Evaluation time range"
              value={hours}
              onChange={(event) => setHours(Number(event.target.value))}
            >
              <option value={1}>Last 1 hour</option>
              <option value={6}>Last 6 hours</option>
              <option value={24}>Last 24 hours</option>
            </select>
            <Button size="small" onClick={() => setRevision((value) => value + 1)}>
              Refresh
            </Button>
          </div>
        </div>
        <AlertChart
          rule={alertForm(alert)}
          chart={preview.data?.chart}
          error={preview.error}
          loading={preview.loading}
          highlights={episodes.map((episode) => ({
            start: Date.parse(episode.startedAt),
            end: Date.parse(episode.endedAt ?? new Date().toISOString()),
            label: `Activation #${episode.id.slice(0, 8)}`,
          }))}
        />
        <p className="alertMuted">
          {alert.windowMinutes}-minute windows reconstructed from telemetry using the current rule. Shading marks
          activations. {Intl.DateTimeFormat().resolvedOptions().timeZone}.
        </p>
      </section>
      <History alert={alert} />
    </div>
  );
}
export function AlertDetailPage() {
  const { alertId = "" } = useParams();
  const loader = useCallback(() => fetchAlert(alertId), [alertId]);
  const result = useResource(alertId, loader);
  return (
    <AppShell active="alerts" redesigned>
      {result.data ? (
        <AlertDetail key={alertId} {...result.data} reload={result.retry} />
      ) : (
        <LoadState error={result.error} retry={result.retry} />
      )}
    </AppShell>
  );
}

function ActivationDetail({ alert, activation }: { alert: TelemetryAlert; activation: TelemetryAlertActivation }) {
  const navigate = useNavigate();
  const chartLoader = useCallback(() => fetchAlertActivationChart(alert.id, activation.id), [alert.id, activation.id]);
  const chart = useResource(activation.id, chartLoader);
  const rule = activation.ruleSnapshot;
  const channels = useResource(
    "slack",
    useCallback(() => fetchAlertSlackChannels(), []),
  );
  const channel = channels.data?.find(
    (item) =>
      item.channelId === activation.slackChannelId && item.integrationAccountId === rule?.slack?.integrationAccountId,
  );
  const destination = channel ? `#${channel.name}` : activation.slackChannelId;
  const unit = rule ? alertValueUnit(rule) : "none";
  const value = (number: number) => formatAlertValue(number, unit);
  const title = `Activation #${activation.id.slice(0, 8)}`;
  useDocumentTitle(`${title} · ${alert.name}`);
  const recovered = activation.endReason === "recovered";
  const notifications = [
    {
      label: "Activated",
      sent: activation.slackMessageTs ? new Date(Number(activation.slackMessageTs) * 1000).toISOString() : null,
    },
    ...(activation.endedAt ? [{ label: "Recovered", sent: activation.recoveryNotifiedAt }] : []),
  ];
  return (
    <div className="alertPage">
      <Header alert={alert} activation={activation}>
        <Button size="small" onClick={() => navigate(`/alerts/${alert.id}`)}>
          View alert
        </Button>
      </Header>
      <div className="alertOverview">
        <div className="alertOverview__copy">
          <p>
            {rule?.name ?? alert.name} activated at {time(activation.startedAt)} on{" "}
            {new Date(activation.startedAt).toLocaleDateString(undefined, {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}{" "}
            with a value of {value(activation.openValue)}
            {activation.groupKey ? ` for ${activation.groupKey}` : ""}.{" "}
            {activation.endedAt
              ? recovered
                ? `It recovered at ${time(activation.endedAt)} with a value of ${value(activation.lastValue)}.`
                : activation.endReason === "configuration_changed"
                  ? "This activation ended when the alert was changed or paused."
                  : "This activation has ended; its closure reason was not recorded."
              : "This activation is still firing."}
          </p>
          <section>
            <h2>Rule at activation</h2>
            <p>
              {rule
                ? `${describeAlertRule(rule)}: ${describeAlertCondition(rule.comparator, rule.threshold, unit)}, checked ${interval(rule.evaluationIntervalSeconds).toLowerCase()}.`
                : "The original configuration was not recorded for this activation."}
            </p>
          </section>
          {rule ? (
            <>
              <Filters alert={rule} />
              <p className="alertMuted">Configuration captured when this activation began.</p>
            </>
          ) : null}
        </div>
        <Properties
          rows={[
            ["State", stateLabel(activation)],
            [
              "Source",
              rule
                ? (rule.filter.service ?? { logs: "Logs", traces: "Spans", metric: "Metric" }[rule.source])
                : "Not recorded",
            ],
            ["Triggered", time(activation.startedAt)],
            [recovered ? "Recovered" : "Ended", activation.endedAt ? time(activation.endedAt) : "—"],
            ["Duration", duration(activation)],
            ["Peak", value(activation.peakValue)],
          ]}
        />
      </div>
      <section className="alertChart">
        <div className="alertSectionHeading">
          <h2>Evaluations around this activation</h2>
        </div>
        {rule ? (
          <AlertChart
            rule={{ ...rule, field: rule.field ?? "", threshold: String(rule.threshold) }}
            chart={chart.data?.chart}
            error={chart.error ?? chart.data?.reason}
            loading={!chart.data && !chart.error}
            highlights={[
              {
                start: Date.parse(activation.startedAt),
                end: Date.parse(activation.endedAt ?? new Date().toISOString()),
                label: title,
              },
            ]}
          />
        ) : (
          <p className="alertEmpty">A chart cannot be reconstructed without the original rule.</p>
        )}
        {chart.error ? (
          <Button size="small" onClick={chart.retry}>
            Retry chart
          </Button>
        ) : null}
        {rule ? (
          <p className="alertMuted">
            {rule.windowMinutes}-minute windows reconstructed from retained telemetry. Shading marks this activation;
            the dashed line is its original threshold.
          </p>
        ) : null}
      </section>
      <section className="alertTimeline">
        <h2>Timeline</h2>
        <ol>
          <li>
            <time dateTime={activation.startedAt}>{time(activation.startedAt, true)}</time>
            <span className="alertTimeline__dot" />
            <div>
              <h3>Alert activated</h3>
              <p>
                {value(activation.openValue)}
                {rule ? `, ${describeAlertCondition(rule.comparator, rule.threshold, unit)}` : ""}.
              </p>
            </div>
          </li>
          {activation.endedAt ? (
            <li>
              <time dateTime={activation.endedAt}>{time(activation.endedAt, true)}</time>
              <span className="alertTimeline__dot alertTimeline__dot--ended" />
              <div>
                <h3>{stateLabel(activation)}</h3>
                <p>
                  {recovered
                    ? `${value(activation.lastValue)}. The value returned within the threshold.`
                    : activation.endReason === "configuration_changed"
                      ? "The alert was changed or paused."
                      : "The closure reason was not recorded."}
                </p>
              </div>
            </li>
          ) : null}
        </ol>
      </section>
      <section className="alertHistory">
        <div className="alertSectionHeading">
          <h2>Notifications</h2>
        </div>
        {activation.slackChannelId ? (
          <div className="alertTableWrap">
            <table className="alertTable">
              <colgroup>
                <col className="alertTable__wide" />
                <col />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Notification</th>
                  <th scope="col">Delivery</th>
                  <th scope="col">Sent</th>
                </tr>
              </thead>
              <tbody>
                {notifications.map((notification) => (
                  <tr key={notification.label}>
                    <td>
                      {notification.label} · Slack {destination}
                    </td>
                    <td>
                      {notification.sent
                        ? "Delivered"
                        : notification.label === "Recovered" && activation.endReason === "configuration_changed"
                          ? "Not sent"
                          : "Not confirmed"}
                    </td>
                    <td>
                      {notification.sent ? (
                        <time dateTime={notification.sent}>{time(notification.sent, true)}</time>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="alertEmpty">No notification destination was recorded for this activation.</p>
        )}
      </section>
    </div>
  );
}
export function AlertActivationPage() {
  const { alertId = "", activationId = "" } = useParams();
  const loader = useCallback(() => fetchAlertActivation(alertId, activationId), [alertId, activationId]);
  const result = useResource(`${alertId}/${activationId}`, loader);
  return (
    <AppShell active="alerts" redesigned>
      {result.data ? (
        <ActivationDetail key={activationId} {...result.data} />
      ) : (
        <LoadState error={result.error} retry={result.retry} />
      )}
    </AppShell>
  );
}
