import { CaretRightIcon, GitPullRequestIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { relativeTime } from "../agents-api";
import { AppShell } from "../components/app-shell";
import { PullRequestListSkeleton } from "../components/screen-skeletons";
import { DataTable } from "../design-system";
import {
  pullRequestReference,
  pullRequestStateLabels,
  pullRequestTitle,
} from "../pull-request-presentation";
import {
  fetchPullRequests,
  type AutomationPullRequestListItem,
  type AutomationPullRequestPage,
  type PullRequestState,
} from "../pull-requests-api";
import { useDocumentTitle } from "../use-document-title";
import "../components/automation-run-history.css";
import "./pull-requests.css";

export function PullRequestStatus({ state }: { state: PullRequestState | null }) {
  if (!state) return <span className="pullRequestStatus">Unknown</span>;
  return <span className={`pullRequestStatus pullRequestStatus--${state}`}><i aria-hidden="true" />{pullRequestStateLabels[state]}</span>;
}

export function PullRequestsPage() {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AutomationPullRequestPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const navigate = useNavigate();
  useDocumentTitle("Pull requests");

  const load = useCallback(async () => {
    const generation = ++request.current;
    try {
      const loaded = await fetchPullRequests(page);
      if (request.current !== generation) return;
      setResult(loaded);
      setError(null);
    } catch (cause) {
      if (request.current === generation) setError(cause instanceof Error ? cause.message : "Unable to load pull requests");
    }
  }, [page]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => { request.current += 1; };
  }, [load]);

  const first = result ? (result.page - 1) * result.pageSize : 0;
  const lastPage = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;

  return (
    <AppShell active="pull-requests" redesigned>
      <header className="workspaceHeading">
        <h1><GitPullRequestIcon aria-hidden="true" size={16} weight="fill" />Pull requests</h1>
      </header>
      {!result ? (
        error
          ? <div className="automationRuns__message" role="alert"><p>{error}</p><button onClick={() => { setError(null); void load(); }} type="button">Retry</button></div>
          : <PullRequestListSkeleton />
      ) : result.total === 0 ? (
        <section className="emptyState emptyState--list">
          <h2>No pull requests yet</h2>
          <p>Pull requests that your automations open appear here.</p>
          <Link className="dsButton dsButton--primary dsButton--medium" to="/automations">
            View automations
          </Link>
        </section>
      ) : (
        <section aria-label="Pull requests" className="automationRuns agentListTable pullRequestList">
          {error ? <p className="formError" role="alert">{error}</p> : null}
          <DataTable<AutomationPullRequestListItem>
            aria-label="Pull requests opened by automations"
            columns={[
              {
                header: "Pull request",
                key: "pull-request",
                render: (pullRequest) => (
                  <span className="agentTableTitle">
                    <Link title={pullRequestTitle(pullRequest)} to={`/pull-requests/${pullRequest.id}`}>
                      <strong>{pullRequestTitle(pullRequest)}</strong>
                    </Link>
                    <small>{pullRequestReference(pullRequest)}</small>
                  </span>
                ),
                width: "50%",
              },
              {
                header: "Automation",
                key: "automation",
                render: (pullRequest) => (
                  <Link className="agentTableCell pullRequestList__automation" onClick={(event) => event.stopPropagation()} to={`/automations/${pullRequest.automationId}/runs/${pullRequest.runId}`}>
                    {pullRequest.automationName}
                  </Link>
                ),
                width: "22%",
              },
              {
                header: "Status",
                key: "status",
                render: (pullRequest) => <PullRequestStatus state={pullRequest.state} />,
                width: "12%",
              },
              {
                header: "Opened",
                key: "opened",
                render: (pullRequest) => (
                  <time className="agentTableCell" dateTime={pullRequest.openedAt} title={new Date(pullRequest.openedAt).toLocaleString()}>
                    {relativeTime(pullRequest.openedAt)}
                  </time>
                ),
                width: "12%",
              },
              {
                header: "",
                key: "open",
                render: () => <CaretRightIcon aria-hidden="true" className="automationRuns__open" size={14} />,
                width: "44px",
              },
            ]}
            getRowKey={(pullRequest) => pullRequest.id}
            onRowClick={(pullRequest) => navigate(`/pull-requests/${pullRequest.id}`)}
            rows={result.pullRequests}
            variant="workspace"
          />
          <footer className="automationRuns__footer">
            {/* A page past the end, after pull requests were removed, has no rows to count. */}
            <span>{result.pullRequests.length > 0 ? `Showing ${first + 1}–${first + result.pullRequests.length} of ${result.total}` : `${result.total}`} {result.total === 1 ? "pull request" : "pull requests"}</span>
            <div>
              <button disabled={result.page <= 1} onClick={() => setPage(result.page - 1)} type="button">Previous</button>
              <button disabled={result.page >= lastPage} onClick={() => setPage(result.page + 1)} type="button">Next</button>
            </div>
          </footer>
        </section>
      )}
    </AppShell>
  );
}
