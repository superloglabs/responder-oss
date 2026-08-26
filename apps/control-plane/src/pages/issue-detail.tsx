import { Fragment, lazy, Suspense, useEffect, useState } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import {
  createIssuePullRequest,
  fetchIssue,
  setIssueArchived,
  type InvestigationTraceEvent,
  type IssueDetailResponse,
  type IssuePullRequestActivity,
} from "../agents-api";
import { AppShell } from "../components/app-shell";
import { EvidenceList, EvidenceSourceGlyph } from "../components/evidence-list";
import {
  ArrowIcon,
  ProviderGlyph,
  PullRequestIcon,
  SeverityIcon,
  StatusDotIcon,
} from "../components/icons";
import { IssueDetailSkeleton } from "../components/screen-skeletons";
import { copyToClipboard } from "../copy-to-clipboard";
import { Button } from "../design-system";
import { useDocumentTitle } from "../use-document-title";
import {
  evidenceSourceLabel,
  groupPullRequestActivities,
  investigationCountLabel,
  investigationStatusTone,
  issueIdentifiedAt,
  issueParagraphs,
  issueRowDate,
  originatingAgentName,
  pullRequestActivityPresentation,
  pullRequestReviewActivityPresentation,
  pullRequestReviewIsActive,
  primaryEvidenceSource,
  pullRequestStateLabel,
  relationshipLabel,
  rowStatusLabel,
} from "./issue-detail-presentation";
import { toolInputSummary, traceEventText } from "./investigation-presentation";

const severityBars = { "SEV-1": 3, "SEV-2": 2, "SEV-3": 1 } as const;
const RemediationDiff = lazy(() =>
  import("../components/remediation-diff").then((module) => ({
    default: module.RemediationDiff,
  })),
);

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

type PullRequestRequest =
  IssueDetailResponse["pullRequestState"]["requests"][number];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function reviewTraceEvent(
  activity: IssuePullRequestActivity,
): InvestigationTraceEvent | null {
  if (activity.event.type !== "review.trace") return null;
  const event = asRecord(activity.event.data?.event);
  if (typeof event?.type !== "string") return null;
  const meta = asRecord(event.meta);
  return {
    ...(event.data === undefined ? {} : { data: event.data }),
    ...(typeof meta?.at === "string" ? { meta: { at: meta.at } } : {}),
    type: event.type,
  };
}

function traceCallId(value: unknown): string | null {
  const record = asRecord(value);
  return typeof record?.callId === "string" ? record.callId : null;
}

function traceToolName(value: unknown): string {
  const raw = typeof value === "string" && value ? value : "tool";
  const label = raw
    .replace(/^mcp_+/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_./:-]+|\s+/)
    .filter(Boolean)
    .join(" ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatTraceTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function PullRequestReviewTrace({
  activities,
}: {
  activities: IssuePullRequestActivity[];
}) {
  const events = activities
    .map(reviewTraceEvent)
    .filter((event): event is InvestigationTraceEvent => Boolean(event));
  const toolResults = new Map<string, InvestigationTraceEvent>();
  for (const event of events) {
    if (event.type !== "action.result") continue;
    const result = asRecord(asRecord(event.data)?.result);
    if (typeof result?.callId === "string") {
      toolResults.set(result.callId, event);
    }
  }

  if (events.length === 0) {
    return <p className="remediationReviewTrace__empty">No trace events recorded.</p>;
  }
  return (
    <div className="remediationReviewTrace">
      <header>
        <strong>Trace</strong>
        <span>{events.length} events</span>
      </header>
      <ol className="traceTimeline remediationReviewTrace__timeline">
        {events.map((event, index) => {
          if (event.type === "action.result") return null;
          if (event.type === "actions.requested") {
            const actions = asRecord(event.data)?.actions;
            if (!Array.isArray(actions)) return null;
            return (
              <Fragment key={`${event.type}-${index}`}>
                {actions.map((action, actionIndex) => {
                  const request = asRecord(action);
                  const callId = traceCallId(action);
                  const resultEvent = callId ? toolResults.get(callId) : undefined;
                  const resultData = asRecord(resultEvent?.data);
                  const result = asRecord(resultData?.result);
                  const failed = resultData?.status === "failed" ||
                    resultData?.error !== undefined;
                  const name = request?.toolName ?? request?.kind;
                  const inputSummary = toolInputSummary(request?.input);
                  return (
                    <li
                      className={`traceTool${failed ? " traceTool--failed" : ""}`}
                      key={callId ?? `${index}-${actionIndex}`}
                    >
                      <details>
                        <summary>
                          <span aria-hidden="true" className="traceTool__icon">⌘</span>
                          <span className="traceTool__label">
                            <span>{traceToolName(name)}</span>
                            {inputSummary ? <code>{inputSummary}</code> : null}
                          </span>
                        </summary>
                        <div className="traceTool__data">
                          <span>Input</span>
                          <pre>{JSON.stringify(request?.input ?? {}, null, 2)}</pre>
                          {resultEvent ? (
                            <>
                              <span>Output</span>
                              <pre>
                                {JSON.stringify(
                                  result?.output ?? resultData?.error ?? result ?? {},
                                  null,
                                  2,
                                )}
                              </pre>
                            </>
                          ) : null}
                        </div>
                      </details>
                    </li>
                  );
                })}
              </Fragment>
            );
          }
          const content = traceEventText(event);
          if (!content) return null;
          const reasoning = event.type === "reasoning.completed";
          return (
            <li
              className={`traceMessage ${reasoning ? "traceMessage--runtime" : "traceMessage--assistant"}`}
              key={`${event.type}-${index}`}
            >
              {reasoning ? (
                <span aria-hidden="true" className="traceMessage__avatar">R</span>
              ) : null}
              <article>
                <header>
                  <span>
                    <strong>{reasoning ? "Reasoning" : "Review agent"}</strong>
                    <small>{reasoning ? "Thinking" : "Update"}</small>
                  </span>
                  <time>{formatTraceTime(event.meta?.at ?? null)}</time>
                </header>
                <div className="traceMessage__content">{content}</div>
              </article>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function PullRequestActivity({ request }: { request: PullRequestRequest }) {
  const activities = request.activities ?? [];
  if (activities.length === 0) return null;
  const timeline = groupPullRequestActivities(activities);
  const latest = timeline.at(-1);
  const latestPresentation = latest?.kind === "review"
    ? pullRequestReviewActivityPresentation(latest.activities)
    : latest
      ? pullRequestActivityPresentation(
          latest.activity,
          request.repositoryFullName,
        )
      : null;

  return (
    <details
      className="remediationActivity"
      open={pullRequestReviewIsActive(activities)}
    >
      <summary>
        <span>
          <strong>Activity</strong>
          {latestPresentation ? <small>{latestPresentation.title}</small> : null}
        </span>
        <span className="remediationActivity__count">
          {timeline.length}
        </span>
      </summary>
      <ol className="remediationActivity__list">
        {timeline.map((item) => {
          if (item.kind === "review") {
            const presentation = pullRequestReviewActivityPresentation(
              item.activities,
            );
            const reviewStartedActivity = item.activities.find(
              (activity) => activity.event.type === "review.session.started",
            ) ?? item.anchor;
            const reviewActive = pullRequestReviewIsActive(item.activities);
            return (
              <li
                className={`remediationActivity__item remediationActivity__item--${presentation.tone}`}
                key={item.jobId}
              >
                <span className="remediationActivity__marker" aria-hidden="true" />
                <details className="remediationReviewRun" open={reviewActive}>
                  <summary>
                    <span>
                      <strong>{presentation.title}</strong>
                      <small>
                        {presentation.traceCount} trace {presentation.traceCount === 1 ? "event" : "events"}
                      </small>
                    </span>
                    <time dateTime={reviewStartedActivity.event.meta.at}>
                      {formatDate(reviewStartedActivity.event.meta.at)}
                    </time>
                  </summary>
                  {presentation.detail ? <p>{presentation.detail}</p> : null}
                  <PullRequestReviewTrace activities={item.activities} />
                </details>
              </li>
            );
          }
          const { activity } = item;
          const presentation = pullRequestActivityPresentation(
            activity,
            request.repositoryFullName,
          );
          return (
            <li
              className={`remediationActivity__item remediationActivity__item--${presentation.tone}`}
              key={activity.id}
            >
              <span className="remediationActivity__marker" aria-hidden="true" />
              <div>
                <div className="remediationActivity__heading">
                  {presentation.href ? (
                    <a href={presentation.href} rel="noreferrer" target="_blank">
                      {presentation.title}
                    </a>
                  ) : (
                    <strong>{presentation.title}</strong>
                  )}
                  <time dateTime={activity.event.meta.at}>
                    {formatDate(activity.event.meta.at)}
                  </time>
                </div>
                {presentation.detail ? <p>{presentation.detail}</p> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

export function IssueDetailPage() {
  const { issueId } = useParams();
  const location = useLocation();
  const [detail, setDetail] = useState<IssueDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archivePending, setArchivePending] = useState(false);
  const [copiedRemediationId, setCopiedRemediationId] = useState<string | null>(
    null,
  );
  const [pullRequestPending, setPullRequestPending] = useState<string | null>(
    null,
  );
  useDocumentTitle(detail?.issue.title ?? "Issue");
  const codeChangeRemediationId = new URLSearchParams(location.search).get(
    "codeChange",
  );

  useEffect(() => {
    if (!issueId) return;
    let cancelled = false;
    void fetchIssue(issueId)
      .then((loaded) => {
        if (!cancelled) setDetail(loaded);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        const message = caught instanceof Error ? caught.message : "Unable to load issue";
        if (message === "Issue not found") setNotFound(true);
        else setError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [issueId]);

  const hasActivePullRequest =
    detail?.pullRequestState.requests.some((request) =>
      request.status === "queued" || request.status === "creating",
    ) ?? false;
  const hasActivePullRequestReview =
    detail?.pullRequestState.requests.some((request) =>
      pullRequestReviewIsActive(request.activities ?? []),
    ) ?? false;
  const hasActiveLinearTicket =
    detail?.linearTicketState.requests.some((request) =>
      request.status === "pending" || request.status === "creating",
    ) ?? false;

  useEffect(() => {
    if (
      !issueId ||
      (!hasActivePullRequest &&
        !hasActivePullRequestReview &&
        !hasActiveLinearTicket)
    ) return;
    const interval = window.setInterval(() => {
      void fetchIssue(issueId).then(setDetail).catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(interval);
  }, [
    hasActiveLinearTicket,
    hasActivePullRequest,
    hasActivePullRequestReview,
    issueId,
  ]);

  useEffect(() => {
    if (!copiedRemediationId) return;
    const timeout = window.setTimeout(() => setCopiedRemediationId(null), 1600);
    return () => window.clearTimeout(timeout);
  }, [copiedRemediationId]);

  useEffect(() => {
    if (!detail || !location.hash) return;
    let remediationId: string;
    try {
      remediationId = decodeURIComponent(location.hash.slice(1));
    } catch {
      return;
    }
    window.requestAnimationFrame(() => {
      document.getElementById(remediationId)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });
  }, [detail, location.hash]);

  if (notFound || !issueId) return <Navigate replace to="/issues" />;
  if (loading) {
    return (
      <AppShell active="issues" density="compact">
        <IssueDetailSkeleton />
      </AppShell>
    );
  }
  if (!detail) {
    return (
      <AppShell active="issues" density="compact">
        <section className="emptyState">
          <h1>Unable to load issue</h1>
          <p>{error ?? "Try again in a moment."}</p>
          <Link className="button button--secondary" to="/issues">
            Back to issues
          </Link>
        </section>
      </AppShell>
    );
  }

  const { issue, investigations } = detail;
  const pullRequests = detail.pullRequestState.requests;
  const linearTickets = detail.linearTicketState.requests;
  const agentName = originatingAgentName(investigations);
  const source = primaryEvidenceSource(issue.evidence);

  async function toggleArchived() {
    if (!issueId || archivePending) return;
    setArchivePending(true);
    setError(null);
    try {
      const updated = await setIssueArchived(issueId, !issue.archivedAt);
      setDetail((current) =>
        current
          ? {
              ...current,
              issue: { ...current.issue, archivedAt: updated.archivedAt },
            }
          : current,
      );
    } catch (caught: unknown) {
      setError(
        caught instanceof Error ? caught.message : "Unable to update issue",
      );
    } finally {
      setArchivePending(false);
    }
  }

  async function createPullRequest(remediationId: string) {
    if (!issueId || pullRequestPending) return;
    setPullRequestPending(remediationId);
    setError(null);
    try {
      await createIssuePullRequest(issueId, remediationId);
      setDetail(await fetchIssue(issueId));
    } catch (caught: unknown) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to create pull request",
      );
    } finally {
      setPullRequestPending(null);
    }
  }

  async function copyPrompt(remediationId: string, prompt: string) {
    setError(null);
    try {
      await copyToClipboard(prompt);
      setCopiedRemediationId(remediationId);
    } catch {
      setCopiedRemediationId(null);
      setError("Unable to copy the remediation prompt");
    }
  }

  return (
    <AppShell active="issues" density="compact">
      <div className="issueDetail">
        <div className="issueDetail__main">
          <header className="issueHeader">
            <Link className="issueHeader__back" to="/issues">
              ← Issues
            </Link>
            <div className="issueHeader__meta">
              <span className="issueSeverityBadge">{issue.severity}</span>
              {issue.archivedAt ? (
                <span className="archivedBadge">Archived</span>
              ) : null}
              <span>Identified {issueIdentifiedAt(issue.createdAt)}</span>
              <span aria-hidden="true" className="issueHeader__separator">
                ·
              </span>
              <span>{investigationCountLabel(investigations.length)}</span>
            </div>
            <h1>{issue.title}</h1>
          </header>

          {error ? <p className="formError">{error}</p> : null}

          <div className="issueProse">
            {issueParagraphs(issue.description).map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>

          <section className="issueSection">
            <h2 className="issueSection__title">Root cause</h2>
            <p className="issueSection__copy">
              {issue.rootCause || "Not recorded."}
            </p>
          </section>

          <section className="issueSection">
            <h2 className="issueSection__title">Timeline</h2>
            {issue.timeline.length > 0 ? (
              <ol className="issueTimeline">
                {issue.timeline.map((entry, index) => (
                  <li key={`${entry.title}-${index}`}>
                    <strong>{entry.title}</strong>
                    <p>{entry.description}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="issueSection__copy">Not recorded.</p>
            )}
          </section>

          <section className="issueSection">
            <h2 className="issueSection__title">Remediations</h2>
            <div className="remediationList">
              {issue.remediations.map((remediation) => {
                const request = pullRequests.find(
                  (candidate) => candidate.remediationId === remediation.id,
                );
                const publishedPullRequest =
                  request?.pullRequestUrl &&
                  (request.status === "created" || request.status === "merged")
                    ? request
                    : null;
                const failedPullRequest =
                  request?.status === "failed" ? request : null;
                return (
                  <article
                    className="remediationCard"
                    id={`remediation-${remediation.id}`}
                    key={remediation.id}
                  >
                    <header className="remediationCard__header">
                      <span
                        className={`remediationCard__kind remediationCard__kind--${remediation.type}`}
                      >
                        {remediation.type === "code_change"
                          ? "Code change"
                          : "External action"}
                      </span>
                      <h3>{remediation.title}</h3>
                    </header>
                    <p className="remediationCard__description">
                      {remediation.description}
                    </p>
                    {remediation.type === "code_change" && publishedPullRequest ? (
                      <>
                        <a
                          className="remediationPullRequest"
                          href={publishedPullRequest.pullRequestUrl ?? undefined}
                          rel="noreferrer"
                          target="_blank"
                        >
                          <span
                            className={`remediationPullRequest__icon remediationPullRequest__icon--${publishedPullRequest.status}`}
                          >
                            <PullRequestIcon />
                          </span>
                          <span className="remediationPullRequest__body">
                            <strong>
                              Pull request #{publishedPullRequest.pullRequestNumber}
                            </strong>
                            <small>{publishedPullRequest.repositoryFullName}</small>
                          </span>
                          <span
                            className={`remediationPullRequest__state remediationPullRequest__state--${publishedPullRequest.status}`}
                          >
                            {pullRequestStateLabel(publishedPullRequest.status)}
                          </span>
                          <ArrowIcon />
                        </a>
                        <PullRequestActivity request={publishedPullRequest} />
                        {codeChangeRemediationId === remediation.id ? (
                          <Suspense
                            fallback={
                              <div className="remediationDiff__loading">
                                Loading proposed diff…
                              </div>
                            }
                          >
                            <RemediationDiff remediation={remediation} />
                          </Suspense>
                        ) : null}
                      </>
                    ) : remediation.type === "code_change" ? (
                      <Suspense
                        fallback={
                          <div className="remediationDiff__loading">
                            Loading proposed diff…
                          </div>
                        }
                      >
                        <RemediationDiff remediation={remediation} />
                      </Suspense>
                    ) : (
                      <div className="remediationPrompt">
                        <span>Prompt for your agent</span>
                        <pre>{remediation.agentPrompt}</pre>
                      </div>
                    )}
                    {remediation.type === "code_change" && publishedPullRequest ? null : (
                      <div className="remediationCard__actions">
                        {remediation.type === "code_change" ? (
                          <>
                            {failedPullRequest?.failureReason ? (
                              <span className="remediationCard__failure">
                                {failedPullRequest.failureReason}
                              </span>
                            ) : null}
                            {request &&
                            ["queued", "creating"].includes(request.status) ? (
                              <span className="remediationCard__status">
                                Opening pull request…
                              </span>
                            ) : detail.pullRequestState.canCreate ? (
                              <Button
                                loading={pullRequestPending === remediation.id}
                                onClick={() => void createPullRequest(remediation.id)}
                                size="small"
                                variant="primary"
                              >
                                {pullRequestPending === remediation.id
                                  ? "Starting…"
                                  : failedPullRequest
                                    ? "Retry pull request"
                                    : "Open pull request"}
                              </Button>
                            ) : null}
                          </>
                        ) : (
                          <Button
                            aria-live="polite"
                            onClick={() =>
                              void copyPrompt(
                                remediation.id,
                                remediation.agentPrompt,
                              )
                            }
                            size="small"
                            variant="secondary"
                          >
                            {copiedRemediationId === remediation.id
                              ? "Copied"
                              : "Copy prompt"}
                          </Button>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>

          <section className="issueSection">
            <h2 className="issueSection__title">Evidence</h2>
            <EvidenceList evidence={issue.evidence} />
          </section>

          <section className="issueSection">
            <h2 className="issueSection__title">Investigations</h2>
            {investigations.length === 0 ? (
              <p className="inlineEmpty">No linked investigations.</p>
            ) : (
              investigations.map((investigation) => (
                <Link
                  className="issueLine"
                  key={investigation.id}
                  to={`/agents/${investigation.agentId}/investigations/${investigation.id}`}
                >
                  <span
                    aria-label={rowStatusLabel(investigation.status)}
                    className={`issueLine__status issueLine__status--${investigationStatusTone(investigation.status)}`}
                    role="img"
                  >
                    <StatusDotIcon />
                  </span>
                  <span className="issueLine__title">{investigation.title}</span>
                  <span className="issueLine__note">
                    {relationshipLabel(investigation.relationship)}
                  </span>
                  <span className="issueLine__spacer" />
                  <span className="issueLine__date">
                    {issueRowDate(investigation.createdAt)}
                  </span>
                  <span className="issueLine__chevron">
                    <ArrowIcon />
                  </span>
                </Link>
              ))
            )}
          </section>

          {pullRequests.length > 0 ? (
            <section className="issueSection">
              <h2 className="issueSection__title">Pull requests</h2>
              {pullRequests.map((request) => (
                <div className="issueLine issueLine--stacked" key={request.id}>
                  <span
                    aria-label={rowStatusLabel(request.status)}
                    className={`issueLine__status issueLine__status--${
                      request.status === "created" || request.status === "merged"
                        ? "resolved"
                        : request.status === "failed"
                          ? "failed"
                          : "pending"
                    }`}
                    role="img"
                  >
                    <PullRequestIcon />
                  </span>
                  <span className="issueLine__body">
                    <strong>
                      {request.status === "created" || request.status === "merged"
                        ? `#${request.pullRequestNumber} in ${request.repositoryFullName}`
                        : request.status === "failed"
                          ? "Pull request failed"
                          : "Creating pull request…"}
                    </strong>
                    <small>
                      {request.failureReason ??
                        `${pullRequestStateLabel(request.status)} · ${formatDate(request.createdAt)}`}
                    </small>
                  </span>
                  {request.pullRequestUrl ? (
                    <a
                      className="issueLine__action"
                      href={request.pullRequestUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Open pull request
                    </a>
                  ) : null}
                </div>
              ))}
            </section>
          ) : null}

          {linearTickets.length > 0 ? (
            <section className="issueSection">
              <h2 className="issueSection__title">Linear tickets</h2>
              {linearTickets.map((request) => (
                <div className="issueLine issueLine--stacked" key={request.id}>
                  <span
                    aria-label={rowStatusLabel(request.status)}
                    className={`issueLine__status${
                      request.status === "failed"
                        ? " issueLine__status--failed"
                        : ""
                    }`}
                    role="img"
                  >
                    <ProviderGlyph decorative provider="linear" />
                  </span>
                  <span className="issueLine__body">
                    <strong>
                      {request.status === "created"
                        ? (request.linearIdentifier ?? request.linearIssueId)
                        : request.status === "failed"
                          ? "Linear ticket failed"
                          : "Creating Linear ticket…"}
                    </strong>
                    <small>
                      {request.failureReason ?? formatDate(request.createdAt)}
                    </small>
                  </span>
                  {request.linearIssueUrl ? (
                    <a
                      className="issueLine__action"
                      href={request.linearIssueUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Open Linear ticket
                    </a>
                  ) : null}
                </div>
              ))}
            </section>
          ) : null}
        </div>

        <aside className="issueRail">
          <div className="issueRail__group">
            <h2 className="issueRail__title">Properties</h2>
            <div className="issueRail__row">
              <span className="issueRail__label">Severity</span>
              <span className="issueRail__icon issueRail__icon--severity">
                <SeverityIcon filled={severityBars[issue.severity]} />
              </span>
              <span className="issueRail__value">{issue.severity}</span>
            </div>
            <div className="issueRail__row">
              <span className="issueRail__label">Agent</span>
              <span className="issueRail__value">{agentName ?? "—"}</span>
            </div>
            <div className="issueRail__row">
              <span className="issueRail__label">Source</span>
              {source ? <EvidenceSourceGlyph source={source} /> : null}
              <span className="issueRail__value">
                {source ? evidenceSourceLabel(source) : "—"}
              </span>
            </div>
          </div>

          <div className="issueRail__actions">
            <Button
              disabled={archivePending}
              loading={archivePending}
              onClick={() => void toggleArchived()}
              size="small"
              variant={issue.archivedAt ? "secondary" : "danger"}
            >
              {archivePending
                ? "Saving…"
                : issue.archivedAt
                  ? "Unarchive"
                  : "Archive"}
            </Button>
          </div>
        </aside>
      </div>
    </AppShell>
  );
}
