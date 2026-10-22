import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { relativeTime } from "../agents-api";
import { AppShell } from "../components/app-shell";
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
          <p className="telemetryPage__status">Loading…</p>
        )}
      </AppShell>
    );
  }

  const { issue } = detail;
  const sample = issue.lastSample;
  const chart = errorIssueChart(detail.days, detail.since);
  const recent = detail.days.reduce((sum, day) => sum + day.eventCount, 0);
  const actions: Array<{ label: string; status: ErrorIssueStatus }> = issue.status === "open"
    ? [{ label: "Silence", status: "silenced" }, { label: "Resolve", status: "resolved" }]
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
            <ErrorIssueStatusBadge status={issue.status} />
            <span className="automationCreate__spacer" />
            {actions.map((action, index) => (
              <Button
                disabled={saving !== null}
                key={action.status}
                loading={saving === action.status}
                onClick={() => void changeStatus(action.status)}
                size="small"
                variant={index === actions.length - 1 ? "secondary" : "ghost"}
              >
                {action.label}
              </Button>
            ))}
          </div>
          <p className="dashboardPage__meta">
            {[
              issue.service,
              issue.kind === "span" ? "Span exception" : "Error log",
              `First seen ${relativeTime(issue.firstSeenAt)}`,
              issue.regressedAt ? `Reopened ${relativeTime(issue.regressedAt)}` : null,
            ].filter(Boolean).join(" · ")}
          </p>
        </header>
        {error ? <p className="formError" role="alert">{error}</p> : null}

        <dl className="syntheticCheck__stats">
          <div className="syntheticCheck__stat">
            <dt>Events</dt>
            <dd title={issue.eventCount.toLocaleString()}>{formatEventCount(issue.eventCount)}</dd>
          </div>
          <div className="syntheticCheck__stat">
            <dt>Last 30 days</dt>
            <dd>{formatEventCount(recent)}</dd>
          </div>
          <div className="syntheticCheck__stat">
            <dt>Last seen</dt>
            <dd title={new Date(issue.lastSeenAt).toLocaleString()}>{relativeTime(issue.lastSeenAt)}</dd>
          </div>
          <div className="syntheticCheck__stat">
            <dt>First seen</dt>
            <dd title={new Date(issue.firstSeenAt).toLocaleString()}>{relativeTime(issue.firstSeenAt)}</dd>
          </div>
        </dl>

        <section aria-label="Occurrences" className="syntheticCheck__section">
          <header>
            <h2>Occurrences</h2>
            <span className="dashboardPage__meta">Per day, last 30 days</span>
          </header>
          <div className="syntheticCheck__chart">
            <TimeseriesChart chart={chart} chartType="bar" label="Occurrences per day" showLegend={false} />
          </div>
        </section>

        <section aria-label="Latest occurrence" className="syntheticCheck__section">
          <header>
            <h2>Latest occurrence</h2>
            <time className="dashboardPage__meta" dateTime={sample.seenAt} title={new Date(sample.seenAt).toLocaleString()}>
              {relativeTime(sample.seenAt)}
            </time>
          </header>
          {sample.message ? <p className="errorIssue__message">{sample.message}</p> : null}
          {sample.stacktrace ? (
            <pre className="errorIssue__stack">{sample.stacktrace}</pre>
          ) : (
            <p className="dashboardWidget__status">The occurrence has no stack trace.</p>
          )}
          {sample.traceId ? (
            <div className="errorIssue__links">
              <Link to={`/traces/${sample.traceId}`}>View trace</Link>
              {sample.spanName ? <span className="dashboardPage__meta">{sample.spanName}</span> : null}
            </div>
          ) : null}
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
