import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchIssues,
  type IssueListItem,
  relativeTime,
} from "../agents-api";
import { AppShell } from "../components/app-shell";
import { ArrowIcon } from "../components/icons";
import { IssueListSkeleton } from "../components/screen-skeletons";
import { DataTable } from "../design-system";
import { useDocumentTitle } from "../use-document-title";
import { issueDateGroupLabel } from "./issues-presentation";

type IssueFilter = "all" | IssueListItem["severity"];

export function IssuesPage() {
  const [issues, setIssues] = useState<IssueListItem[]>([]);
  const [issueFilter, setIssueFilter] = useState<IssueFilter>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useDocumentTitle("Issues");

  useEffect(() => {
    let cancelled = false;
    void fetchIssues(showArchived)
      .then((loaded) => {
        if (!cancelled) setIssues(loaded);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Unable to load issues");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showArchived]);

  const filteredIssues = issues.filter(
    (issue) => issueFilter === "all" || issue.severity === issueFilter,
  );

  return (
    <AppShell active="issues">
      <section className="pageHeading">
        <div>
          <h1>Issues</h1>
          <p>Distinct failure mechanisms identified across investigations.</p>
        </div>
        <label className="issueArchiveFilter">
          <span>Show archived</span>
          <input
            checked={showArchived}
            onChange={(event) => {
              setLoading(true);
              setError(null);
              setShowArchived(event.target.checked);
            }}
            type="checkbox"
          />
          <span aria-hidden="true" className="toggle" />
        </label>
      </section>

      {error ? <p className="formError">{error}</p> : null}
      {loading ? (
        <IssueListSkeleton />
      ) : issues.length === 0 ? (
        <section className="emptyState emptyState--list">
          <h2>No issues identified</h2>
          <p>Issues will appear after an investigation submits a finding.</p>
        </section>
      ) : (
        <DataTable<IssueListItem, IssueFilter>
          aria-label="Identified issues"
          activeFilter={issueFilter}
          columns={[
            {
              header: "Issue",
              key: "issue",
              render: (issue) => (
                <Link className="issueTableTitle" to={`/issues/${issue.id}`}>
                  <span>{issue.title}</span>
                  {issue.archivedAt ? (
                    <span className="archivedBadge">Archived</span>
                  ) : null}
                </Link>
              ),
              width: "70%",
            },
            {
              header: "Severity",
              key: "severity",
              render: (issue) => (
                <span
                  className={`issueTableSeverity issueTableSeverity--${issue.severity.toLowerCase()}`}
                >
                  {issue.severity}
                </span>
              ),
              width: "12%",
            },
            {
              header: "Created",
              key: "created",
              render: (issue) => (
                <time
                  className="issueTableCreated"
                  dateTime={issue.createdAt}
                >
                  {relativeTime(issue.createdAt)}
                </time>
              ),
              width: "13%",
            },
            {
              align: "right",
              header: "",
              key: "open",
              render: (issue) => (
                <Link
                  aria-label={`Open ${issue.title}`}
                  className="issueTableArrow"
                  to={`/issues/${issue.id}`}
                >
                  <ArrowIcon />
                </Link>
              ),
              width: "5%",
            },
          ]}
          filters={[
            { count: issues.length, label: "All", value: "all" },
            {
              count: issues.filter((issue) => issue.severity === "SEV-1")
                .length,
              dot: "var(--ds-danger)",
              label: "SEV 1",
              value: "SEV-1",
            },
            {
              count: issues.filter((issue) => issue.severity === "SEV-2")
                .length,
              dot: "var(--ds-warning)",
              label: "SEV 2",
              value: "SEV-2",
            },
            {
              count: issues.filter((issue) => issue.severity === "SEV-3")
                .length,
              dot: "var(--ds-text-muted)",
              label: "SEV 3",
              value: "SEV-3",
            },
          ]}
          getRowGroup={(issue) => issueDateGroupLabel(issue.createdAt)}
          getRowKey={(issue) => issue.id}
          onFilterChange={setIssueFilter}
          rows={filteredIssues}
        />
      )}
    </AppShell>
  );
}
