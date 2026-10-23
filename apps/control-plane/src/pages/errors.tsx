import { BugIcon, CaretRightIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { relativeTime } from "../agents-api";
import { AppShell } from "../components/app-shell";
import { Button, DataTable, SelectField } from "../design-system";
import {
  dailyCounts,
  daysThroughToday,
  errorIssueStatusLabels,
  fetchErrorIssues,
  formatEventCount,
  type ErrorIssueFilter,
  type ErrorIssueList,
  type ErrorIssueListItem,
  type ErrorIssueStatus,
} from "../error-issues-api";
import { useDocumentTitle } from "../use-document-title";
import "../components/automation-run-history.css";
import "../components/error-issues.css";
import "../components/telemetry-explorer.css";

type StatusFilter = ErrorIssueStatus | "all";
const statusFilters: StatusFilter[] = ["open", "resolved", "silenced", "all"];

function statusFilter(value: string | null): StatusFilter {
  return statusFilters.includes(value as StatusFilter) ? (value as StatusFilter) : "open";
}

export function ErrorSparkline({ counts, label }: { counts: number[]; label: string }) {
  const highest = Math.max(1, ...counts);
  return (
    <span aria-label={label} className="errorSparkline" role="img">
      {counts.map((count, index) => (
        <span
          data-filled={count > 0}
          key={index}
          style={{ height: count > 0 ? `${Math.max(12, (count / highest) * 100)}%` : undefined }}
        />
      ))}
    </span>
  );
}

export function ErrorsPage() {
  useDocumentTitle("Errors");
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = statusFilter(params.get("status"));
  const service = params.get("service") ?? "";
  const search = params.get("q") ?? "";
  const [searchText, setSearchText] = useState(search);
  // Undefined while loading; null when the workspace cannot use telemetry.
  const [list, setList] = useState<ErrorIssueList | null | undefined>(undefined);
  const [older, setOlder] = useState<{ done: boolean; issues: ErrorIssueListItem[] } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  // Changes with the filter, so an older page fetched for a previous filter
  // is dropped.
  const filterGeneration = useRef(0);

  const filter: ErrorIssueFilter = { status, ...(service ? { service } : {}), ...(search ? { search } : {}) };

  function setFilter(update: { q?: string; service?: string; status?: StatusFilter }) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(update)) {
      if (value && !(key === "status" && value === "open")) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace: true });
  }

  const load = useCallback(async () => {
    const generation = ++latest.current;
    try {
      const loaded = await fetchErrorIssues({ status, ...(service ? { service } : {}), ...(search ? { search } : {}) });
      if (latest.current !== generation) return;
      setList(loaded);
      setError(null);
    } catch (cause) {
      if (latest.current !== generation) return;
      setError(cause instanceof Error ? cause.message : "Unable to load errors");
    }
  }, [search, service, status]);

  useEffect(() => {
    filterGeneration.current += 1;
    void Promise.resolve().then(() => {
      setOlder(null);
      return load();
    });
  }, [load]);

  // Older pages are paged from the first page as loaded, so the list stops
  // refreshing once they are shown.
  useEffect(() => {
    if (older) return;
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load, older]);

  // The search is applied a moment after typing stops.
  useEffect(() => {
    if (searchText.trim() === search) return;
    const timer = setTimeout(() => setFilter({ q: searchText.trim() }), 300);
    return () => clearTimeout(timer);
  });

  async function loadMore() {
    const shown = [...(list?.issues ?? []), ...(older?.issues ?? [])];
    const last = shown.at(-1);
    if (!last) return;
    const generation = filterGeneration.current;
    setLoadingMore(true);
    try {
      const more = await fetchErrorIssues({ ...filter, before: last });
      if (generation !== filterGeneration.current) return;
      setOlder({ done: (more?.issues.length ?? 0) < 50, issues: [...(older?.issues ?? []), ...(more?.issues ?? [])] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load more errors");
    } finally {
      setLoadingMore(false);
    }
  }

  const issues = list ? [...list.issues, ...(older?.issues ?? [])] : [];
  const days = list ? daysThroughToday(list.since) : 14;
  const filtered = Boolean(service || search);
  const total = list ? list.counts.open + list.counts.resolved + list.counts.silenced : 0;

  return (
    <AppShell active="errors" redesigned>
      <div className="errorIssues">
        <header className="workspaceHeading">
          <h1><BugIcon aria-hidden="true" size={16} weight="bold" />Errors</h1>
        </header>
        {list === undefined ? (
          error ? (
            <div className="automationRuns__message" role="alert">
              <p>{error}</p>
              <button onClick={() => void load()} type="button">Retry</button>
            </div>
          ) : (
            <p className="telemetryPage__status">Loading…</p>
          )
        ) : list === null ? (
          <section className="emptyState emptyState--list">
            <h2>Errors are not available</h2>
            <p>This workspace cannot use telemetry yet.</p>
          </section>
        ) : total === 0 ? (
          <section className="emptyState emptyState--list">
            <h2>No errors yet</h2>
            <p>Exceptions and error logs your services send are grouped here into issues, one per distinct problem.</p>
            <Link className="dsButton dsButton--secondary dsButton--small" to="/telemetry/setup">Send telemetry</Link>
          </section>
        ) : (
          <>
            <div className="explorerToolbar">
              <label className="explorerFilterBar">
                <MagnifyingGlassIcon aria-hidden="true" size={14} />
                <input
                  aria-label="Search errors"
                  onChange={(event) => setSearchText(event.target.value)}
                  placeholder="Search errors…"
                  type="search"
                  value={searchText}
                />
              </label>
              {list.services.length > 0 ? (
                <SelectField
                  className="explorerSelect"
                  label="Service"
                  onChange={(value) => setFilter({ service: value })}
                  options={[{ label: "All services", value: "" }, ...list.services.map((name) => ({ label: name, value: name }))]}
                  searchable={list.services.length > 8}
                  value={service}
                />
              ) : null}
            </div>
            {error ? <p className="formError" role="alert">{error}</p> : null}
            <section aria-label="Errors" className="automationRuns agentListTable">
              <DataTable<ErrorIssueListItem, StatusFilter>
                activeFilter={status}
                aria-label="Errors"
                columns={[
                  {
                    header: "Issue",
                    key: "title",
                    render: (issue) => (
                      <span className="agentTableTitle">
                        <Link className="errorIssues__title" title={issue.title} to={`/errors/${issue.id}`}>
                          <strong>{issue.title}</strong>
                        </Link>
                        <small className="errorIssues__meta">
                          {[issue.service, issue.topFrame].filter(Boolean).join(" · ") || issue.exceptionType}
                        </small>
                      </span>
                    ),
                  },
                  {
                    header: `Last ${days} days`,
                    key: "trend",
                    render: (issue) => (
                      <ErrorSparkline
                        counts={dailyCounts(issue.days, list.since, days)}
                        label={`Occurrences per day over the last ${days} days`}
                      />
                    ),
                    width: "120px",
                  },
                  {
                    align: "right",
                    header: "Events",
                    key: "events",
                    render: (issue) => (
                      <span className="agentTableCell errorIssues__number" title={issue.eventCount.toLocaleString()}>
                        {formatEventCount(issue.eventCount)}
                      </span>
                    ),
                    width: "80px",
                  },
                  {
                    header: "Last seen",
                    key: "lastSeen",
                    render: (issue) => (
                      <time className="agentTableCell" dateTime={issue.lastSeenAt} title={new Date(issue.lastSeenAt).toLocaleString()}>
                        {relativeTime(issue.lastSeenAt)}
                      </time>
                    ),
                    width: "100px",
                  },
                  {
                    header: "First seen",
                    key: "firstSeen",
                    render: (issue) => (
                      <time className="agentTableCell" dateTime={issue.firstSeenAt} title={new Date(issue.firstSeenAt).toLocaleString()}>
                        {relativeTime(issue.firstSeenAt)}
                      </time>
                    ),
                    width: "100px",
                  },
                  {
                    header: "",
                    key: "open",
                    render: () => <CaretRightIcon aria-hidden="true" className="automationRuns__open" size={14} />,
                    width: "44px",
                  },
                ]}
                emptyMessage={filtered ? "No errors match these filters." : `No ${status === "all" ? "" : `${errorIssueStatusLabels[status as ErrorIssueStatus].toLowerCase()} `}errors.`}
                filters={statusFilters.map((value) => ({
                  count: value === "all" ? total : list.counts[value],
                  label: value === "all" ? "All" : errorIssueStatusLabels[value],
                  value,
                }))}
                getRowKey={(issue) => issue.id}
                onFilterChange={(value) => setFilter({ status: value })}
                onRowClick={(issue) => navigate(`/errors/${issue.id}`)}
                rows={issues}
                variant="workspace"
              />
            </section>
            {!older?.done && issues.length >= 50 ? (
              <Button className="errorIssues__more" loading={loadingMore} onClick={() => void loadMore()} size="small" variant="ghost">
                Show older errors
              </Button>
            ) : null}
          </>
        )}
      </div>
    </AppShell>
  );
}
