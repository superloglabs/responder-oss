import { NavigationIcon } from "../components/navigation-icon";
import { PlusIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { relativeTime } from "../agents-api";
import { AppShell } from "../components/app-shell";
import { Button, Checkbox, DataTable, SelectField } from "../design-system";
import {
  dailyCounts,
  daysThroughToday,
  errorState,
  fetchErrorIssues,
  formatEventCount,
  hourlyCounts,
  updateErrorIssueStatus,
  type ErrorIssueFilter,
  type ErrorIssueList,
  type ErrorIssueListItem,
  type ErrorIssueStatus,
} from "../error-issues-api";
import { ErrorFilterMenu, ErrorFilterChips } from "../components/error-filters";
import { readErrorFilters, type FilterProperty } from "../error-filter-state";
import { useDocumentTitle } from "../use-document-title";
import "../components/automation-run-history.css";
import "../components/error-issues.css";
import "../components/telemetry-explorer.css";

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
  const filters = readErrorFilters(params);
  const rangeValue = params.get("range") ?? "24h";
  const range = (["24h", "7d", "14d", "30d", "all"].includes(rangeValue) ? rangeValue : "24h") as ErrorIssueFilter["range"];
  const filterKey = params.toString();
  const sortValue = params.get("sort");
  const sort = sortValue === "events" || sortValue === "firstSeen" ? sortValue : "lastSeen";
  const search = params.get("q") ?? "";
  const [searchText, setSearchText] = useState(search);
  // Undefined while loading; null when the workspace cannot use telemetry.
  const [list, setList] = useState<ErrorIssueList | null | undefined>(undefined);
  const [older, setOlder] = useState<{ done: boolean; issues: ErrorIssueListItem[] } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const [facets, setFacets] = useState({ services: [] as string[], environments: [] as string[] });
  // Changes with the filter, so an older page fetched for a previous filter
  // is dropped.
  const filterGeneration = useRef(0);

  const filter: ErrorIssueFilter = {
    status: "all", sort, statuses: filters.status as ErrorIssueStatus[], services: filters.service,
    environments: filters.environment, range,
    // Values within a property are ORed. Both exhaustive activity states
    // match every issue, so only a single selected state needs a predicate.
    ...(filters.activity.length === 1 ? { activity: filters.activity[0] as "active" | "inactive" } : {}),
    ...(search ? { search } : {}),
  };
  const requestKey = JSON.stringify(filter);

  function setFilter(update: { q?: string; range?: string; sort?: string }) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(update)) {
      if (value) next.set(key, value); else next.delete(key);
    }
    setParams(next, { replace: true });
  }
  function changeProperty(property: FilterProperty, values: string[]) {
    const next = new URLSearchParams(params);
    next.delete(property);
    values.forEach((value) => next.append(property, value));
    if (property === "status" && values.length === 0) next.set("status", "all");
    setParams(next, { replace: true });
  }

  const load = useCallback(async () => {
    const generation = ++latest.current;
    try {
      const loaded = await fetchErrorIssues(JSON.parse(requestKey) as ErrorIssueFilter);
      if (latest.current !== generation) return;
      setList(loaded);
      if (loaded) setFacets({ services: loaded.services, environments: loaded.environments });
      setError(null);
    } catch (cause) {
      if (latest.current !== generation) return;
      setError(cause instanceof Error ? cause.message : "Unable to load errors");
    }
  }, [requestKey, setList, setFacets, setError]);

  useEffect(() => {
    filterGeneration.current += 1;
    void Promise.resolve().then(() => {
      setOlder(null);
      setSelected([]);
      setPage(0);
      setList(undefined);
      return load();
    });
  }, [load]);

  // Older pages are paged from the first page as loaded, so the list stops
  // refreshing once they are shown.
  useEffect(() => {
    if (older || saving || loadingMore) return;
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load, older, saving, loadingMore]);

  useEffect(() => { void Promise.resolve().then(() => setSearchText(search)); }, [search]);

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
    latest.current += 1;
    setLoadingMore(true);
    try {
      const more = await fetchErrorIssues({ ...filter, before: last });
      if (generation !== filterGeneration.current) return;
      if (more?.issues.length) setPage((current) => current + 1);
      setSelected([]);
      setOlder({ done: (more?.issues.length ?? 0) < 50, issues: [...(older?.issues ?? []), ...(more?.issues ?? [])] });
    } catch (cause) {
      if (generation === filterGeneration.current) setError(cause instanceof Error ? cause.message : "Unable to load more errors");
    } finally {
      setLoadingMore(false);
    }
  }

  async function changeSelectedStatus(status: ErrorIssueStatus) {
    const generation = filterGeneration.current;
    setSaving(true);
    const results = await Promise.allSettled(selected.map((id) => updateErrorIssueStatus(id, status)));
    if (filterGeneration.current === generation) {
      const failed = selected.filter((_, index) => results[index]?.status === "rejected");
      setSelected(failed);
      setOlder(null);
      setPage(0);
      await load();
      if (failed.length) setError(`Could not update ${failed.length} errors. Please retry.`);
    }
    setSaving(false);
  }

  const allIssues = list ? [...list.issues, ...(older?.issues ?? [])] : [];
  const issues = allIssues.slice(page * 50, (page + 1) * 50);
  const hourly = list?.interval === "hour";
  const days = list && !hourly ? daysThroughToday(list.since) : 14;
  const filtered = Boolean(filterKey);
  const total = list ? list.counts.open + list.counts.resolved + list.counts.silenced : 0;

  return (
    <AppShell active="errors" redesigned>
      <div className="errorIssues">
        <header className="errorIssues__heading">
          <div className="workspaceHeading"><h1><NavigationIcon section="errors" />Errors</h1>
          <Link className="dsButton dsButton--primary dsButton--small" to="/alerts/new"><PlusIcon size={14} />Create alert</Link></div>
          <p>Find recurring failures and decide what to investigate next.</p>
        </header>
        <div className="errorIssues__filters">
          <div className="explorerToolbar">
            <label className="explorerFilterBar"><MagnifyingGlassIcon aria-hidden="true" size={14} />
              <input aria-label="Search errors" onChange={(event) => setSearchText(event.target.value)} placeholder="Search errors by message or ID…" type="search" value={searchText} />
            </label>
            <ErrorFilterMenu filters={filters} services={facets.services} environments={facets.environments} onChange={changeProperty} />
            <SelectField label="Time range" onChange={(value) => setFilter({ range: value })} options={[{label:"Last 24 hours",value:"24h"},{label:"Last 7 days",value:"7d"},{label:"Last 14 days",value:"14d"},{label:"Last 30 days",value:"30d"},{label:"All time",value:"all"}]} value={range ?? "24h"} />
          </div>
          <div className="errorIssues__filterRow"><div className="errorIssues__chips"><ErrorFilterChips filters={filters} onChange={changeProperty} /><ErrorFilterMenu compact filters={filters} services={facets.services} environments={facets.environments} onChange={changeProperty} /></div><SelectField label="Sort errors" value={sort} onChange={(value) => setFilter({ sort: value })} options={[{ label: "Sort: Last seen", value: "lastSeen" }, { label: "Sort: First seen", value: "firstSeen" }, { label: "Sort: Events", value: "events" }]} /></div>
        </div>
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
            {error ? <p className="formError" role="alert">{error}</p> : null}
            {selected.length > 0 ? <div className="errorIssues__bulk" aria-label="Selected errors">
              <span>{selected.length} selected</span>
              <Button disabled={saving} onClick={() => void changeSelectedStatus("resolved")} size="small">Resolve</Button>
              <Button disabled={saving} onClick={() => void changeSelectedStatus("silenced")} size="small">Ignore</Button>
              <Button disabled={saving} onClick={() => void changeSelectedStatus("open")} size="small">Reopen</Button>
              <Button onClick={() => setSelected([])} size="small" variant="ghost">Clear selection</Button>
            </div> : null}
            <section aria-label="Errors" className="automationRuns agentListTable">
              <DataTable<ErrorIssueListItem>
                aria-label="Errors"
                columns={[
                  { header: <Checkbox label="Select visible errors" className="errorIssues__checkbox" checked={issues.length > 0 && issues.every((issue) => selected.includes(issue.id))} onChange={(event) => setSelected(event.target.checked ? issues.map((issue) => issue.id) : [])} />, key: "select", width: "40px", render: (issue) => <Checkbox label={`Select ${issue.title}`} className="errorIssues__checkbox" checked={selected.includes(issue.id)} disabled={saving} onChange={(event) => setSelected((current) => event.target.checked ? [...current, issue.id] : current.filter((id) => id !== issue.id))} /> },
                  {
                    header: "Error",
                    key: "title",
                    render: (issue) => (
                      <span className="agentTableTitle">
                        <Link className="errorIssues__title" title={issue.title} to={`/errors/${issue.id}`}>
                          <strong>{issue.title}</strong>
                        </Link>
                        <small className="errorIssues__meta">
                          {[issue.service, issue.id.slice(0, 8), issue.topFrame].filter(Boolean).join(" · ") || issue.exceptionType}
                        </small>
                      </span>
                    ),
                  },
                  { header: "State", key: "state", width: "108px", render: (issue) => <span className="agentTableCell">{errorState(issue)}</span> },
                  {
                    align: "right",
                    header: "Events",
                    key: "events",
                    render: (issue) => (
                      <span className="agentTableCell errorIssues__number" title={`${issue.eventCount.toLocaleString()} lifetime events`}>
                        {formatEventCount(issue.eventCount)}
                      </span>
                    ),
                    width: "80px",
                  },
                  {
                    header: hourly ? "Hourly trend" : "Daily trend",
                    key: "trend",
                    render: (issue) => hourly ? (
                      <ErrorSparkline
                        counts={hourlyCounts(issue.hours ?? [], list.since, 24)}
                        label="Occurrences per hour over the last 24 hours"
                      />
                    ) : (
                      <ErrorSparkline
                        counts={dailyCounts(issue.days, list.since, days)}
                        label={`Occurrences per day over the last ${days} days`}
                      />
                    ),
                    width: "120px",
                  },
                  {
                    header: "Last seen",
                    key: "lastSeen",
                    render: (issue) => (
                      <time className="agentTableCell" dateTime={issue.lastSeenAt} title={new Date(issue.lastSeenAt).toLocaleString()}>
                        {relativeTime(issue.lastSeenAt)}
                      </time>
                    ),
                    width: "120px",
                  },
                ]}
                emptyMessage={filtered ? "No errors match these filters." : "No unresolved errors."}
                getRowKey={(issue) => issue.id}
                onRowClick={(issue) => navigate(`/errors/${issue.id}`)}
                rows={issues}
                variant="workspace"
              />
            </section>
            <div className="errorIssues__pagination">
              <span>{issues.length ? `${page * 50 + 1}–${page * 50 + issues.length} errors` : "0 errors"}</span>
              <div><span>Page {page + 1}</span>
                <Button disabled={page === 0 || loadingMore || saving} onClick={() => { setPage(page - 1); setSelected([]); }} size="small">Previous</Button>
                <Button disabled={loadingMore || saving || (allIssues.length <= (page + 1) * 50 && (older?.done || issues.length < 50))} loading={loadingMore} onClick={() => { if (allIssues.length > (page + 1) * 50) { setPage(page + 1); setSelected([]); } else void loadMore(); }} size="small">Next</Button>
              </div>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
