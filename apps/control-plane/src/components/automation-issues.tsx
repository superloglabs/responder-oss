import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  fetchAutomationIssues,
  type AutomationIssue,
  type AutomationIssuePage,
} from "../automations-api";
import { relativeTime } from "../agents-api";
import { dateGroupLabel } from "../date-presentation";
import { DataTable } from "../design-system";
import { IssueSeverity } from "./issue-severity";
import { AutomationRunHistorySkeleton } from "./screen-skeletons";
import "./automation-run-history.css";
import "./automation-issues.css";

function SeenCell({ value }: { value: string }) {
  return <time className="agentTableCell" dateTime={value} title={new Date(value).toLocaleString()}>{relativeTime(value)}</time>;
}

// The issues the automation reported. Repeats of an alert are counted on its
// issue instead of being reported again.
export function AutomationIssues({ automationId }: { automationId: string }) {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AutomationIssuePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const request = useRef(0);
  const navigate = useNavigate();
  const runPath = (issue: AutomationIssue) => issue.filedRunId ? `/automations/${automationId}/runs/${issue.filedRunId}` : null;

  const load = useCallback(async () => {
    const generation = ++request.current;
    try {
      const loaded = await fetchAutomationIssues(automationId, page);
      if (request.current !== generation) return;
      setResult(loaded);
      setError(null);
    } catch (cause) {
      if (request.current === generation) setError(cause instanceof Error ? cause.message : "Unable to load issues");
    }
  }, [automationId, page]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => { request.current += 1; };
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!result) {
    return error
      ? <div className="automationRuns__message" role="alert"><p>{error}</p><button onClick={() => { setError(null); void load(); }} type="button">Retry</button></div>
      : <AutomationRunHistorySkeleton />;
  }

  const first = (result.page - 1) * result.pageSize;
  const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));

  return <section className="automationIssues agentListTable" aria-label="Issues">
    {error ? <p className="formError" role="alert">{error}</p> : null}
    <DataTable<AutomationIssue>
      aria-label="Automation issues"
      columns={[
        {
          header: "Issue",
          key: "issue",
          render: (issue) => {
            const path = runPath(issue);
            return <span className="agentTableTitle">
              {path ? <Link title={issue.title} to={path}><strong>{issue.title}</strong></Link> : <strong title={issue.title}>{issue.title}</strong>}
            </span>;
          },
        },
        {
          header: "Severity",
          key: "severity",
          render: (issue) => issue.severity ? <IssueSeverity severity={issue.severity} /> : <span className="agentTableCell">—</span>,
          width: "100px",
        },
        {
          align: "right",
          header: "Occurrences",
          key: "occurrences",
          render: (issue) => <span className="agentTableCell automationIssues__count">{issue.occurrences.toLocaleString()}</span>,
          width: "120px",
        },
        { header: "Last seen", key: "lastSeen", render: (issue) => <SeenCell value={issue.lastSeenAt} />, width: "124px" },
      ]}
      emptyMessage="No issues yet. Each problem this automation reports is listed here, and repeats of its alert are counted on it."
      getRowGroup={(issue) => dateGroupLabel(issue.lastSeenAt, now)}
      getRowKey={(issue) => issue.id}
      onRowClick={(issue) => {
        const path = runPath(issue);
        if (path) navigate(path);
      }}
      rows={result.issues}
      variant="workspace"
    />
    {result.total > 0 ? <footer className="automationRuns__footer">
      <span>Showing {first + 1}–{first + result.issues.length} of {result.total} {result.total === 1 ? "issue" : "issues"}</span>
      <div>
        <button disabled={result.page <= 1} onClick={() => setPage(result.page - 1)} type="button">Previous</button>
        <button disabled={result.page >= lastPage} onClick={() => setPage(result.page + 1)} type="button">Next</button>
      </div>
    </footer> : null}
  </section>;
}
