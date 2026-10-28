import { AttributeTable } from "../components/telemetry-explorer";
import { DashboardTimePicker } from "../components/dashboard-time-picker";
import { zoomOutTimeRange } from "../dashboard-time-range";
import { useTimeZonePreference } from "../use-time-zone-preference";
import {
  logExplorerParams,
  logExplorerQuery,
  traceExplorerParams,
  traceSearchQuery,
  type ExplorerFilter,
  type LogExplorerQuery,
  type TraceSearchQuery,
} from "../telemetry-api";
import { LogExplorer } from "./logs";
import { TraceExplorer } from "./traces";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { relativeTime } from "../agents-api";
import { AppShell } from "../components/app-shell";
import { ErrorIssueSkeleton } from "../components/screen-skeletons";
import { TimeseriesChart } from "../components/timeseries-chart";
import { Badge, Button } from "../design-system";
import {
  errorIssueDetailChart,
  errorIssueRange,
  errorIssueStatusLabels,
  fetchErrorIssue,
  formatEventCount,
  updateErrorIssueStatus,
  type ErrorIssueDetail,
  type ErrorIssueStatus,
} from "../error-issues-api";
import { useDocumentTitle } from "../use-document-title";
import "../components/alerts.css";
import "../components/dashboards.css";
import "../components/error-issues.css";
import "../components/synthetics.css";
import "./automation-create.css";

export function ErrorIssueStatusBadge({ status }: { status: ErrorIssueStatus }) {
  return <Badge tone={status === "open" ? "danger" : "neutral"}>{errorIssueStatusLabels[status]}</Badge>;
}

// The issue's own logs and spans, which the worker recorded as it grouped them.
function issueFilter(issueId: string): ExplorerFilter {
  return { key: "field.error_issue", op: "eq", value: issueId };
}

function useExplorerWindow() {
  const [now, setNow] = useState(() => Date.now());
  const { changeTimeZone, timeZone, timeZonePreference } = useTimeZonePreference();
  return { changeTimeZone, now, setNow, timeZone, timeZonePreference };
}

function IssueTraces({ issue }: { issue: ErrorIssueDetail["issue"] }) {
  const window = useExplorerWindow();
  const [query, setQuery] = useState<TraceSearchQuery>(() => ({
    ...traceSearchQuery(new URLSearchParams(`range=${errorIssueRange(issue.lastSeenAt, window.now)}`)),
    filters: [issueFilter(issue.id)],
  }));
  const [openTrace, setOpenTrace] = useState<string | null>(null);
  function updateQuery(update: Partial<TraceSearchQuery>) {
    if (update.range) window.setNow(Date.now());
    setQuery((current) => ({ ...current, ...update }));
    setOpenTrace(null);
  }
  return (
    <section aria-label="Traces" className="errorIssue__traces">
      <header className="errorIssue__tracesHeading">
        <h2>Traces</h2>
        <Link to={`/traces/search?${traceExplorerParams(query)}`}>Open in trace search ↗</Link>
        <DashboardTimePicker
          now={window.now} onChange={(range) => updateQuery({ range })}
          onTimeZoneChange={window.changeTimeZone}
          onZoomOut={() => updateQuery({ range: zoomOutTimeRange(query.range, Date.now(), null).range })}
          range={query.range} timeZone={window.timeZone} timeZonePreference={window.timeZonePreference} zoomed={false}
        />
      </header>
      <p className="dashboardPage__meta">{issue.kind === "span" ? "Traces with a span where this error occurred." : "Traces with a span that logged this error."}</p>
      <TraceExplorer now={window.now} refresh={0} timeZone={window.timeZone} onOpenTrace={setOpenTrace}
        openTrace={openTrace} query={query} setQuery={updateQuery} showVolume={false} />
    </section>
  );
}

function IssueLogs({ issue }: { issue: ErrorIssueDetail["issue"] }) {
  const window = useExplorerWindow();
  const [query, setQuery] = useState<LogExplorerQuery>(() => ({
    ...logExplorerQuery(new URLSearchParams(`range=${errorIssueRange(issue.lastSeenAt, window.now)}`)),
    filters: [issueFilter(issue.id)],
  }));
  function updateQuery(update: Partial<LogExplorerQuery>) {
    if (update.range) window.setNow(Date.now());
    setQuery((current) => ({ ...current, ...update }));
  }
  return (
    <section aria-label="Logs" className="errorIssue__traces">
      <header className="errorIssue__tracesHeading">
        <h2>Logs</h2>
        <Link to={`/logs?${logExplorerParams(query)}`}>Open in logs ↗</Link>
        <DashboardTimePicker
          now={window.now} onChange={(range) => updateQuery({ range })}
          onTimeZoneChange={window.changeTimeZone}
          onZoomOut={() => updateQuery({ range: zoomOutTimeRange(query.range, Date.now(), null).range })}
          range={query.range} timeZone={window.timeZone} timeZonePreference={window.timeZonePreference} zoomed={false}
        />
      </header>
      <p className="dashboardPage__meta">{issue.kind === "log" ? "The logs grouped into this error." : "Logs from the spans where this error occurred."}</p>
      <LogExplorer now={window.now} refresh={0} timeZone={window.timeZone} query={query} setQuery={updateQuery} />
    </section>
  );
}

export function ErrorIssuePage() {
  const { issueId = "" } = useParams();
  const [detail, setDetail] = useState<ErrorIssueDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<ErrorIssueStatus | null>(null);
  // A load is kept only if no other load or status change started after it.
  const generation = useRef(0);
  useDocumentTitle(detail?.issue.title ?? "Error");

  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoadError(null);
    try {
      const loaded = await fetchErrorIssue(issueId);
      if (generation.current === request) setDetail(loaded);
    } catch (cause) {
      if (generation.current === request) setLoadError(cause instanceof Error ? cause.message : "Unable to load the error");
    }
  }, [issueId]);

  useEffect(() => {
    void Promise.resolve().then(load);
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [issueId, load]);

  async function changeStatus(status: ErrorIssueStatus) {
    generation.current += 1;
    setSaving(status);
    setError(null);
    try {
      const issue = await updateErrorIssueStatus(issueId, status);
      setDetail((current) => (current ? { ...current, issue } : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to change the status");
    } finally {
      setSaving(null);
    }
  }

  if (!detail || detail.issue.id !== issueId) {
    return (
      <AppShell active="errors" redesigned wide>
        {loadError ? (
          <div className="automationRuns__message" role="alert">
            <p>{loadError}</p>
            <button onClick={() => void load()} type="button">Retry</button>
          </div>
        ) : (
          <ErrorIssueSkeleton />
        )}
      </AppShell>
    );
  }

  const { issue } = detail;
  const sample = issue.lastSample;
  const chart = errorIssueDetailChart(detail);
  const hourly = chart.stepMs < 86_400_000;
  const recent = detail.days.reduce((sum, day) => sum + day.eventCount, 0);
  const actions: Array<{ label: string; status: ErrorIssueStatus }> = issue.status === "open"
    ? [{ label: "Ignore", status: "silenced" }, { label: "Resolve", status: "resolved" }]
    : [{ label: "Reopen", status: "open" }];

  return (
    <AppShell active="errors" redesigned wide>
      <div className="errorIssue syntheticCheck">
        <header className="automationCreate__header">
          <nav aria-label="Breadcrumb" className="automationCreate__breadcrumb">
            <Link to="/errors">Errors</Link>
            <span aria-hidden="true">›</span>
            <span aria-current="page">{issue.exceptionType}</span>
          </nav>
          <div className="dashboardPage__titleRow errorIssue__titleRow">
            <h1>{issue.title}</h1>
            <span className="automationCreate__spacer" />
            {actions.map((action, index) => (
              <Button
                disabled={saving !== null}
                key={action.status}
                loading={saving === action.status}
                onClick={() => void changeStatus(action.status)}
                size="small"
                variant={index === actions.length - 1 ? "primary" : "secondary"}
              >
                {action.label}
              </Button>
            ))}
          </div>
          <p className="dashboardPage__meta">{formatEventCount(issue.eventCount)} total events · {issue.kind === "span" ? "Span exception" : "Error log"}{issue.regressedAt ? ` · Reopened ${relativeTime(issue.regressedAt)}` : ""}</p>
        </header>
        {error || loadError ? <p className="formError" role="alert">{error ?? loadError}</p> : null}
        <section className="errorIssue__overview" aria-label="Error overview">
          <div className="errorIssue__summary">
            <section aria-label="Latest occurrence" className="syntheticCheck__section">
              <header>
                <h2>Latest event</h2>
                <time className="errorIssue__eventTime" dateTime={sample.seenAt}>{new Date(sample.seenAt).toLocaleString()}</time>
                {sample.traceId ? <Link className="dsButton dsButton--secondary dsButton--small" to={`/traces/${sample.traceId}`}>View trace</Link> : null}
                <span className="dashboardPage__meta">{relativeTime(sample.seenAt)}</span>
              </header>
              <pre className="errorIssue__eventMessage">{sample.message ?? issue.message ?? issue.title}</pre>
              {sample.stacktrace ? <details className="errorIssue__stackPanel"><summary>Stack trace</summary><pre className="errorIssue__stack">{sample.stacktrace}</pre></details> : null}
            </section>
            <AttributeTable grouped scopes={[
              { label: sample.kind === "span" ? "Span" : "Log", prefix: sample.kind === "span" ? "span." : "log.", values: sample.attributes },
              { label: "Resource", prefix: "resource.", values: Object.fromEntries(Object.entries(sample.resourceAttributes).filter(([key]) => key !== "service.version")) },
            ]} />
          </div>
          <dl className="errorIssue__properties">
            <div><dt>Status</dt><dd><span className={`errorIssue__status errorIssue__status--${issue.status}`}><i aria-hidden="true" />{errorIssueStatusLabels[issue.status]}</span></dd></div>
            {[
              ["Service", issue.service ?? "—"],
              ["Environment", sample.resourceAttributes["deployment.environment.name"] ?? sample.resourceAttributes["deployment.environment"] ?? sample.attributes["deployment.environment.name"] ?? sample.attributes["deployment.environment"] ?? "—"],
              ["First seen", new Date(issue.firstSeenAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })],
              ["Last seen", relativeTime(issue.lastSeenAt)],
            ].map(([name, value]) => <div key={name}><dt>{name}</dt><dd title={value}>{value}</dd></div>)}
          </dl>
        </section>

        <section aria-label="Occurrences" className="syntheticCheck__section">
          <header>
            <h2>Occurrences</h2>
            <span className="dashboardPage__meta">{formatEventCount(recent)} events · {hourly ? "Every 3 hours" : "Daily"}, last 30 days</span>
          </header>
          <div className="syntheticCheck__chart">
            <TimeseriesChart chart={chart} chartType="bar" density="compact" adjacentBars={hourly} label={hourly ? "Occurrences every 3 hours" : "Occurrences per day"} showLegend={false} />
          </div>
        </section>

        {issue.kind === "span" ? (
          <>
            <IssueTraces issue={issue} key={`traces:${issue.id}`} />
            <IssueLogs issue={issue} key={`logs:${issue.id}`} />
          </>
        ) : (
          <>
            <IssueLogs issue={issue} key={`logs:${issue.id}`} />
            <IssueTraces issue={issue} key={`traces:${issue.id}`} />
          </>
        )}

        {issue.frames.length > 0 ? (
          <section aria-label="Grouped by" className="syntheticCheck__section">
            <header>
              <h2>Grouped by</h2>
              <span className="errorIssue__fingerprint">{issue.fingerprint}</span>
            </header>
            <p className="dashboardPage__meta">
              Occurrences with this exception type, a matching message, and these application frames are one issue.
            </p>
            <ol className="errorIssue__frames">
              {issue.frames.map((frame, index) => <li key={`${index}:${frame}`} title={frame}>{frame}</li>)}
            </ol>
          </section>
        ) : null}

      </div>
    </AppShell>
  );
}
