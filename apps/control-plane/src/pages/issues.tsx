import { IssueSeverity } from "../components/issue-severity";
import { ListDashesIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchIssues, type IssueListItem, relativeTime } from "../agents-api";
import { AppShell } from "../components/app-shell";
import { dateGroupLabel } from "../date-presentation";
import { useDocumentTitle } from "../use-document-title";

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
      .then((loaded) => { if (!cancelled) setIssues(loaded); })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Unable to load issues");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [showArchived]);

  const groups = new Map<string, IssueListItem[]>();
  const now = new Date();
  for (const issue of issues.filter((issue) => issueFilter === "all" || issue.severity === issueFilter)) {
    const label = dateGroupLabel(issue.createdAt, now);
    groups.set(label, [...(groups.get(label) ?? []), issue]);
  }

  return (
    <AppShell active="issues" density="issues">
      <div className="issuesPage">
        <header className="issuesHeading">
          <h1><ListDashesIcon aria-hidden="true" size={16} weight="fill" />Issues</h1>
          <details className="issuesFilters">
            <summary>Filters{issueFilter !== "all" || showArchived ? " · Active" : ""}</summary>
            <div className="issuesFilters__popover">
              <label>Severity<select value={issueFilter} onChange={(event) => setIssueFilter(event.target.value as IssueFilter)}>
                <option value="all">All severities</option>
                <option value="SEV-1">SEV-1</option><option value="SEV-2">SEV-2</option><option value="SEV-3">SEV-3</option>
              </select></label>
              <label className="issuesFilters__archive"><input type="checkbox" checked={showArchived} onChange={(event) => {
                setLoading(true); setError(null); setShowArchived(event.target.checked);
              }} />Show archived</label>
            </div>
          </details>
        </header>
        {error ? <p className="formError" role="alert">{error}</p> : loading ? (
          <div className="issuesLoading" role="status" aria-busy="true"><span className="srOnly">Loading issues…</span>{Array.from({ length: 6 }, (_, index) => <div key={index} />)}</div>
        ) : groups.size === 0 ? (
          <section className="issuesEmpty"><h2>{issues.length ? "No matching issues" : "No issues identified"}</h2><p>{issues.length ? "Choose another severity to see more issues." : "Issues will appear after an investigation submits a finding."}</p></section>
        ) : Array.from(groups, ([label, rows]) => (
          <section className="issuesGroup" key={label} aria-label={label}>
            <h2>{label}</h2>
            <div className="issuesTableSurface">
              <table className="issuesTable" aria-label={label + " issues"}>
                <colgroup><col className="issuesTable__titleColumn" /><col /><col /></colgroup>
                <thead><tr><th scope="col">Issue</th><th scope="col">Severity</th><th scope="col">Created</th></tr></thead>
                <tbody>{rows.map((issue) => <tr key={issue.id}>
                  <td><Link to={"/issues/" + issue.id} title={issue.title}><span>{issue.title}</span>{issue.archivedAt ? <small>Archived</small> : null}</Link></td>
                  <td><IssueSeverity severity={issue.severity} /></td>
                  <td><time dateTime={issue.createdAt} title={new Date(issue.createdAt).toLocaleString()}>{relativeTime(issue.createdAt)}</time></td>
                </tr>)}</tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    </AppShell>
  );
}
