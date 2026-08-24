import { useEffect, useState } from "react";
import { renderIssueFixPrompt } from "@responder/core/investigations/report";
import { Link, Navigate, useParams } from "react-router-dom";
import {
  createIssuePullRequest,
  fetchIssue,
  setIssueArchived,
  type IssueDetailResponse,
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
  investigationCountLabel,
  investigationStatusTone,
  issueIdentifiedAt,
  issueParagraphs,
  issueRowDate,
  originatingAgentName,
  primaryEvidenceSource,
  relationshipLabel,
} from "./issue-detail-presentation";

const severityBars = { "SEV-1": 3, "SEV-2": 2, "SEV-3": 1 } as const;

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function IssueDetailPage() {
  const { issueId } = useParams();
  const [detail, setDetail] = useState<IssueDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archivePending, setArchivePending] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [pullRequestPending, setPullRequestPending] = useState(false);
  useDocumentTitle(detail?.issue.title ?? "Issue");

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
  const hasActiveLinearTicket =
    detail?.linearTicketState.requests.some((request) =>
      request.status === "pending" || request.status === "creating",
    ) ?? false;

  useEffect(() => {
    if (!issueId || (!hasActivePullRequest && !hasActiveLinearTicket)) return;
    const interval = window.setInterval(() => {
      void fetchIssue(issueId).then(setDetail).catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(interval);
  }, [hasActiveLinearTicket, hasActivePullRequest, issueId]);

  useEffect(() => {
    if (!promptCopied) return;
    const timeout = window.setTimeout(() => setPromptCopied(false), 1600);
    return () => window.clearTimeout(timeout);
  }, [promptCopied]);

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

  async function createPullRequest() {
    if (!issueId || pullRequestPending) return;
    setPullRequestPending(true);
    setError(null);
    try {
      await createIssuePullRequest(issueId);
      setDetail(await fetchIssue(issueId));
    } catch (caught: unknown) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to create pull request",
      );
    } finally {
      setPullRequestPending(false);
    }
  }

  async function copyPrompt() {
    setError(null);
    try {
      await copyToClipboard(renderIssueFixPrompt(issue));
      setPromptCopied(true);
    } catch {
      setPromptCopied(false);
      setError("Unable to copy the issue prompt");
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

          <section className="issueCallout">
            <h2>Remediation</h2>
            <p>{issue.remediation}</p>
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
                    className={`issueLine__status issueLine__status--${investigationStatusTone(investigation.status)}`}
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
                    className={`issueLine__status issueLine__status--${
                      request.status === "created"
                        ? "resolved"
                        : request.status === "failed"
                          ? "failed"
                          : "pending"
                    }`}
                  >
                    <PullRequestIcon />
                  </span>
                  <span className="issueLine__body">
                    <strong>
                      {request.status === "created"
                        ? `#${request.pullRequestNumber} in ${request.repositoryFullName}`
                        : request.status === "failed"
                          ? "Pull request failed"
                          : "Creating pull request…"}
                    </strong>
                    <small>
                      {request.failureReason ?? formatDate(request.createdAt)}
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
                    className={`issueLine__status${
                      request.status === "failed"
                        ? " issueLine__status--failed"
                        : ""
                    }`}
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
            {detail.pullRequestState.canCreate ? (
              <Button
                loading={pullRequestPending}
                onClick={() => void createPullRequest()}
                size="small"
                variant="primary"
              >
                {pullRequestPending ? "Starting…" : "Create pull request"}
              </Button>
            ) : null}
            <Button
              aria-live="polite"
              onClick={() => void copyPrompt()}
              size="small"
              variant="secondary"
            >
              {promptCopied ? "Copied" : "Copy prompt"}
            </Button>
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
