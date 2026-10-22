import { CaretRightIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  fetchAutomationIssues,
  type AutomationIssue,
  type AutomationIssuePage,
} from "../automations-api";
import { dateGroupLabel } from "../date-presentation";
import { DataTable } from "../design-system";
import { AutomationRunHistorySkeleton } from "./screen-skeletons";
import "./automation-run-history.css";

function seenLabel(value: string): string {
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", hourCycle: "h23", minute: "2-digit" }).format(new Date(value));
  const day = dateGroupLabel(value);
  if (day === "Today" || day === "Yesterday") return `${day}, ${time}`;
  return `${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(new Date(value))}, ${time}`;
}

function linkLabel(link: AutomationIssue["links"][number]): string {
  if (link.label) return link.label;
  try {
    return new URL(link.url).hostname.replace(/^www\./u, "");
  } catch {
    return link.url;
  }
}

// Only web pages are shown as links.
function webLinks(issue: AutomationIssue): AutomationIssue["links"] {
  return issue.links.filter((link) => {
    try {
      return ["http:", "https:"].includes(new URL(link.url).protocol);
    } catch {
      return false;
    }
  });
}

function SeenCell({ value }: { value: string }) {
  return <time className="agentTableCell" dateTime={value} title={new Date(value).toLocaleString()}>{seenLabel(value)}</time>;
}

// The issues the automation reported. Repeats of an alert are counted on its
// issue instead of being reported again.
export function AutomationIssues({ automationId }: { automationId: string }) {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AutomationIssuePage | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  if (!result) {
    return error
      ? <div className="automationRuns__message" role="alert"><p>{error}</p><button onClick={() => { setError(null); void load(); }} type="button">Retry</button></div>
      : <AutomationRunHistorySkeleton />;
  }

  const first = (result.page - 1) * result.pageSize;
  const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));

  return <section className="automationRuns automationIssues agentListTable" aria-label="Issues">
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
              <small title={issue.summary}>{issue.summary}</small>
            </span>;
          },
          width: "46%",
        },
        {
          header: "Occurrences",
          key: "occurrences",
          render: (issue) => <span className="agentTableCell automationIssues__count">{issue.occurrences.toLocaleString()}</span>,
          width: "11%",
        },
        { header: "First seen", key: "firstSeen", render: (issue) => <SeenCell value={issue.firstSeenAt} />, width: "13.5%" },
        { header: "Last seen", key: "lastSeen", render: (issue) => <SeenCell value={issue.lastSeenAt} />, width: "13.5%" },
        {
          header: "Links",
          key: "links",
          render: (issue) => webLinks(issue).length > 0
            ? <span className="automationIssues__links">{webLinks(issue).map((link) => <a href={link.url} key={link.url} onClick={(event) => event.stopPropagation()} rel="noreferrer" target="_blank" title={link.url}>{linkLabel(link)}</a>)}</span>
            : <span className="agentTableCell">—</span>,
          width: "16%",
        },
        {
          header: "",
          key: "open",
          render: (issue) => runPath(issue) ? <CaretRightIcon aria-hidden="true" className="automationRuns__open" size={14} /> : null,
          width: "44px",
        },
      ]}
      emptyMessage="No issues yet. Each problem this automation reports is listed here, and repeats of its alert are counted on it."
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
