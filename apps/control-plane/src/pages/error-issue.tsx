import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { relativeTime } from "../agents-api";
import { AppShell } from "../components/app-shell";
import { ErrorIssueSkeleton } from "../components/screen-skeletons";
import { TimeseriesChart } from "../components/timeseries-chart";
import { Badge, Button } from "../design-system";
import {
  errorIssueChart,
  errorIssueStatusLabels,
  fetchErrorIssue,
  formatEventCount,
  sampleAttributes,
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

function Attributes({ attributes, label }: { attributes: Record<string, string>; label: string }) {
  const entries = sampleAttributes(attributes);
  if (entries.length === 0) return null;
  return (
    <section aria-label={label} className="syntheticCheck__section">
      <header><h2>{label}</h2></header>
      <dl className="errorIssue__attributes">
        {entries.map(([key, value]) => (
          <div key={key} style={{ display: "contents" }}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
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
      <AppShell active="errors" redesigned>
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
  const chart = errorIssueChart(detail.days, detail.since);
  const recent = detail.days.reduce((sum, day) => sum + day.eventCount, 0);
  const actions: Array<{ label: string; status: ErrorIssueStatus }> = issue.status === "open"
    ? [{ label: "Ignore", status: "silenced" }, { label: "Resolve", status: "resolved" }]
    : [{ label: "Reopen", status: "open" }];

  return (
    <AppShell active="errors" redesigned>
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
        </header>
        {error || loadError ? <p className="formError" role="alert">{error ?? loadError}</p> : null}
        <section className="errorIssue__overview" aria-label="Error overview">
          <div className="errorIssue__summary">
            <p className="errorIssue__message">{issue.message ?? issue.title}</p>
            <p className="dashboardPage__meta">{formatEventCount(issue.eventCount)} total events · {issue.kind === "span" ? "Span exception" : "Error log"}{issue.regressedAt ? ` · Reopened ${relativeTime(issue.regressedAt)}` : ""}</p>
          </div>
          <dl className="errorIssue__properties">
            <div><dt>Status</dt><dd><ErrorIssueStatusBadge status={issue.status} /></dd></div>
            {[
              ["Service", issue.service ?? "—"],
              ["Environment", sample.resourceAttributes["deployment.environment.name"] ?? sample.resourceAttributes["deployment.environment"] ?? sample.attributes["deployment.environment.name"] ?? sample.attributes["deployment.environment"] ?? "—"],
              ["Service version", sample.resourceAttributes["service.version"] ?? "—"],
              ["First seen", new Date(issue.firstSeenAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })],
              ["Last seen", relativeTime(issue.lastSeenAt)],
            ].map(([name, value]) => <div key={name}><dt>{name}</dt><dd className={name === "Service version" ? "errorIssue__version" : undefined} title={value}>{value}</dd></div>)}
          </dl>
        </section>

        <section aria-label="Occurrences" className="syntheticCheck__section">
          <header>
            <h2>Occurrences</h2>
            <span className="dashboardPage__meta">{formatEventCount(recent)} events · Daily, last 30 days</span>
          </header>
          <div className="syntheticCheck__chart">
            <TimeseriesChart chart={chart} chartType="bar" density="compact" label="Occurrences per day" showLegend={false} />
          </div>
        </section>

        <section aria-label="Latest occurrence" className="syntheticCheck__section">
          <header>
            <h2>Latest event</h2>
            {sample.traceId ? <Link className="dsButton dsButton--secondary dsButton--small" to={`/traces/${sample.traceId}`}>View trace</Link> : null}
            <time className="dashboardPage__meta" dateTime={sample.seenAt} title={new Date(sample.seenAt).toLocaleString()}>
              {relativeTime(sample.seenAt)}
            </time>
          </header>
          {sample.message ? <p className="errorIssue__message">{sample.message}</p> : null}
          {sample.stacktrace ? (
            <div className="errorIssue__stackPanel"><div className="errorIssue__stackHeading">{issue.topFrame ?? issue.exceptionType}</div><pre className="errorIssue__stack">{sample.stacktrace}</pre></div>
          ) : (
            <p className="dashboardWidget__status">The occurrence has no stack trace.</p>
          )}
        </section>

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

        <Attributes attributes={sample.attributes} label={sample.kind === "span" ? "Span attributes" : "Log attributes"} />
        <Attributes attributes={sample.resourceAttributes} label="Resource attributes" />
      </div>
    </AppShell>
  );
}
