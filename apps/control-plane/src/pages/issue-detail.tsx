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
import { EvidenceList } from "../components/evidence-list";
import { ArrowIcon } from "../components/icons";
import { IssueDetailSkeleton } from "../components/screen-skeletons";
import { copyToClipboard } from "../copy-to-clipboard";
import { Button } from "../design-system";
import { useDocumentTitle } from "../use-document-title";

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
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
      <section className="issueDetailHeading">
        <div>
          <Link className="backLink" to="/issues">
            ← Back to issues
          </Link>
          <div className="issueTitleStack">
            <div className="issueTitleBadges">
              <span className="issueSeverityBadge">{issue.severity}</span>
              {issue.archivedAt ? (
                <span className="archivedBadge">Archived</span>
              ) : null}
            </div>
            <div className="issueTitleBlock">
              <h1>{issue.title}</h1>
              <p>
                Identified {formatDate(issue.createdAt)}
                {issue.archivedAt
                  ? ` · Archived ${formatDate(issue.archivedAt)}`
                  : ""}
              </p>
            </div>
          </div>
        </div>
        <div className="buttonGroup">
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
        </div>
      </section>

      {error ? <p className="formError">{error}</p> : null}

      <div className="issueDetailContent">
        <section className="issueDefinition">
          <article className="issueDefinitionCard">
            <h2>Description</h2>
            <p>{issue.description}</p>
          </article>
          <article className="issueDefinitionCard">
            <h2>Remediation</h2>
            <p>{issue.remediation}</p>
          </article>
          <article className="issueDefinitionCard issueDefinitionCard--evidence">
            <h2>Evidence</h2>
            <EvidenceList evidence={issue.evidence} />
          </article>
        </section>

        <section className="issueInvestigations">
          <header>
            <h2>Investigations</h2>
          </header>
          {investigations.length === 0 ? (
            <p className="inlineEmpty">No linked investigations.</p>
          ) : (
            <div className="issueInvestigationList">
              {investigations.map((investigation) => (
                <Link
                  className="issueInvestigationRow shadow-xl"
                  key={investigation.id}
                  to={`/agents/${investigation.agentId}/investigations/${investigation.id}`}
                >
                  <span>
                    <strong>{investigation.title}</strong>
                    <small>
                      {investigation.agentName} ·{" "}
                      {investigation.relationship === "new"
                        ? "First identified"
                        : "Recurrence"}{" "}
                      · {formatDate(investigation.createdAt)}
                    </small>
                  </span>
                  <span className="issueRow__arrow">
                    <ArrowIcon />
                  </span>
                </Link>
              ))}
            </div>
          )}
          {detail.pullRequestState.requests.length > 0 ? (
            <div className="issuePullRequests">
              <header>
                <h2>Pull requests</h2>
              </header>
              <div className="issueInvestigationList">
                {detail.pullRequestState.requests.map((request) => (
                  <div
                    className="issueInvestigationRow shadow-xl"
                    key={request.id}
                  >
                    <span>
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
                        className="button button--secondary button--small"
                        href={request.pullRequestUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Open pull request
                      </a>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {detail.linearTicketState.requests.length > 0 ? (
            <div className="issuePullRequests">
              <header>
                <h2>Linear tickets</h2>
              </header>
              <div className="issueInvestigationList">
                {detail.linearTicketState.requests.map((request) => (
                  <div
                    className="issueInvestigationRow shadow-xl"
                    key={request.id}
                  >
                    <span>
                      <strong>
                        {request.status === "created"
                          ? request.linearIdentifier ?? request.linearIssueId
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
                        className="button button--secondary button--small"
                        href={request.linearIssueUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Open Linear ticket
                      </a>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}
