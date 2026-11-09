import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { IconCopy, IconFlag, IconSearch } from "@tabler/icons-react";
import { Button } from "../design-system";
import { useDocumentTitle } from "../use-document-title";
import {
  fetchFinding,
  fetchFindings,
  findingStatusLabel,
  foundLabel,
  groupFindingsByDay,
  recordPromptCopied,
  setFindingStatus,
  type SignalFindingDetail,
  type SignalFindingSummary,
  type SignalPeriod,
} from "./model";
import { SignalComputerIllustration } from "./computer-illustration";
import { PeriodSelect, Severity } from "./shared";

function useDebounced<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function SignalFindings() {
  useDocumentTitle("Signal · Findings");
  const [search, setSearch] = useState("");
  const [days, setDays] = useState<SignalPeriod>(14);
  const query = useDebounced(search, 250);
  // Results keep the filters and offset they were loaded for, so changing a
  // filter starts again from the first page and shows loading until it lands.
  const filters = `${days}|${query}`;
  // A request is the filters, the offset to load from, and an attempt
  // counter that "Try again" bumps to repeat a failed load.
  const [requested, setRequested] = useState({ filters, offset: 0, attempt: 0 });
  // New filters always start from the first page, also when they match
  // filters used before.
  if (requested.filters !== filters) setRequested({ filters, offset: 0, attempt: 0 });
  const offset = requested.filters === filters ? requested.offset : 0;
  const attempt = requested.filters === filters ? requested.attempt : 0;
  const [page, setPage] = useState<{
    filters: string; offset: number; attempt: number; findings: SignalFindingSummary[]; total: number; error?: string;
  }>({ filters: "", offset: -1, attempt: 0, findings: [], total: 0 });
  useEffect(() => {
    let current = true;
    fetchFindings({ days, search: query, offset })
      .then((loaded) => {
        if (!current) return;
        setPage((previous) => ({
          filters,
          offset,
          attempt,
          total: loaded.total,
          findings: offset > 0 && previous.filters === filters ? [...previous.findings, ...loaded.findings] : loaded.findings,
        }));
      })
      .catch((failure: unknown) => {
        if (!current) return;
        // Rows already shown for these filters stay; rows from other filters go.
        setPage((previous) => ({
          filters,
          offset,
          attempt,
          findings: previous.filters === filters ? previous.findings : [],
          total: previous.filters === filters ? previous.total : 0,
          error: failure instanceof Error ? failure.message : "Could not load findings.",
        }));
      });
    return () => { current = false; };
  }, [days, query, filters, offset, attempt]);

  const loading = page.filters !== filters || page.offset !== offset || page.attempt !== attempt;
  const findings = page.filters === filters ? page.findings : [];
  const total = page.filters === filters ? page.total : 0;
  const error = loading ? "" : page.error ?? "";
  const now = new Date();
  const groups = groupFindingsByDay(findings, now);
  const filtered = Boolean(query.trim()) || days !== 14;
  return <section className="signalFindings">
    <h1 className="signalListHeading"><IconFlag size={16} stroke={2} />Findings</h1>
    <div className="signalFilters">
      <label className="signalSearch"><IconSearch size={14} /><input aria-label="Search findings" placeholder="Search findings…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
      <PeriodSelect days={days} onChange={setDays} />
    </div>
    {error && <p className="signalError" role="alert">{error}</p>}
    {groups.map((group) => <section className="signalFindingGroup" key={group.key}>
      <h2>{group.label}</h2>
      <div className="signalTableSurface"><table><colgroup><col className="signalFindingTitleColumn" /><col /><col /></colgroup>
        <thead><tr><th scope="col">Finding</th><th scope="col">Severity</th><th scope="col">Found</th></tr></thead>
        <tbody>{group.findings.map((finding) => <tr key={finding.id}>
          <td><Link to={`/signal/findings/${finding.id}`}>{finding.title}</Link></td>
          <td><Severity level={finding.severity} /></td>
          <td>{foundLabel(new Date(finding.postedAt), now)}</td>
        </tr>)}</tbody>
      </table></div>
    </section>)}
    {!loading && !error && findings.length === 0 && (filtered
      ? <div className="signalEmpty">
        <h2>No matching findings</h2><p>Try another search or date range.</p><Button onClick={() => { setSearch(""); setDays(14); }}>Clear filters</Button>
      </div>
      : <div className="signalEmpty signalEmpty--waiting">
        <SignalComputerIllustration />
        <h2>No findings yet</h2>
        <p>We’re now looking through billions of logs. As soon as we see an issue, we’ll report it.</p>
      </div>)}
    <footer className="signalListFooter">
      <span role="status">{loading ? "Loading…" : `Showing ${findings.length} of ${total} findings`}</span>
      {!loading && error
        ? <Button onClick={() => setRequested({ filters, offset, attempt: attempt + 1 })}>Try again</Button>
        : !loading && findings.length < total && <Button onClick={() => setRequested({ filters, offset: findings.length, attempt: 0 })}>Load more</Button>}
    </footer>
  </section>;
}

export function SignalFindingDetail() {
  const { findingId = "" } = useParams();
  // The loaded finding keeps its ID, so opening another one shows loading.
  const [loaded, setLoaded] = useState<{ id: string; finding?: SignalFindingDetail; state: "ready" | "missing" | "error" } | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const finding = loaded?.id === findingId ? loaded.finding ?? null : null;
  const state = loaded?.id === findingId ? loaded.state : "loading";
  const setFinding = (next: SignalFindingDetail) => setLoaded({ id: findingId, finding: next, state: "ready" });
  useDocumentTitle(finding ? `Signal · ${finding.id}` : "Signal · Finding");

  useEffect(() => {
    let current = true;
    fetchFinding(findingId)
      .then((result) => { if (current) setLoaded({ id: findingId, finding: result, state: "ready" }); })
      .catch((failure: unknown) => {
        if (!current) return;
        setLoaded({ id: findingId, state: failure instanceof Error && failure.message === "Finding not found." ? "missing" : "error" });
      });
    return () => { current = false; };
  }, [findingId]);

  if (state === "loading") return <p className="signalLoading" role="status">Loading…</p>;
  if (state !== "ready" || !finding) {
    return <section className="signalEmpty">
      <h1>{state === "missing" ? "Finding not found" : "Could not load this finding"}</h1>
      <Link to="/signal/findings">Back to findings</Link>
    </section>;
  }
  const irrelevant = finding.status === "irrelevant";

  async function toggleIrrelevant() {
    if (!finding) return;
    setSaving(true);
    try {
      const { status } = await setFindingStatus(finding.id, irrelevant ? "new" : "irrelevant");
      setFinding({ ...finding, status });
    } catch (failure) {
      setCopyStatus(failure instanceof Error ? `Could not change the status: ${failure.message}` : "Could not change the status.");
    } finally {
      setSaving(false);
    }
  }
  async function copyPrompt() {
    if (!finding) return;
    try {
      await navigator.clipboard.writeText(finding.prompt);
      setCopyStatus("Prompt copied");
    } catch {
      setCopyStatus("Could not copy. Select and copy the prompt under Evidence instead.");
      return;
    }
    const { status } = await recordPromptCopied(finding.id).catch(() => ({ status: finding.status }));
    setFinding({ ...finding, status });
  }

  return <article className="signalDetail">
    <header>
      <nav className="workspaceBreadcrumb" aria-label="Breadcrumb"><Link to="/signal/findings">Findings</Link><span aria-hidden="true">›</span><span>{finding.id}</span></nav>
      <div className="signalDetailHeader"><div><h1>{finding.title}</h1><p>{finding.subtitle}</p></div>
        <div className="signalDetailActions">
          <Button disabled={saving} onClick={() => void toggleIrrelevant()}>{irrelevant ? "Restore finding" : "Mark as irrelevant"}</Button>
          <Button variant="primary" onClick={() => void copyPrompt()}><IconCopy size={14} />Copy prompt</Button>
        </div>
      </div><span className="signalCopyStatus" role="status">{copyStatus}</span>
    </header>
    <div className="signalDetailColumns">
      <div className="signalDetailMain">
        <section><h2>Impact</h2><p>{finding.impact}</p></section>
        <section><h2>Root cause</h2><p>{finding.rootCause}</p></section>
        {finding.suggestedFix && <section><h2>Suggested fix</h2><p>{finding.suggestedFix}</p></section>}
        <section className="signalEvidence"><h2>Evidence</h2>
          {finding.evidence.map((item, index) => <section className="signalCode" key={`${item.kind}-${index}`}>
            <header><h3>{item.title}</h3><span>{evidenceLabel(item.kind)}</span></header>
            <pre className="signalLog"><code>{item.detail}</code></pre>
          </section>)}
        </section>
        <details className="signalPrompt">
          <summary>Prompt</summary>
          <pre><code>{finding.prompt}</code></pre>
        </details>
      </div>
      <aside className="signalProperties"><h2>Properties</h2><dl>
        <dt>Severity</dt><dd><Severity level={finding.severity} /></dd>
        <dt>Status</dt><dd>{findingStatusLabel(finding.status)}</dd>
        {finding.service && <><dt>Service</dt><dd>{finding.service}</dd></>}
        {finding.affectedUsers !== null && <><dt>Users</dt><dd>{finding.affectedUsers}</dd></>}
        {finding.affectedRequests !== null && <><dt>Requests</dt><dd>{finding.affectedRequests}</dd></>}
        <dt>Found</dt><dd>{foundLabel(new Date(finding.postedAt), new Date())}</dd>
      </dl></aside>
    </div>
  </article>;
}

function evidenceLabel(kind: SignalFindingDetail["evidence"][number]["kind"]) {
  return { logs: "Logs", traces: "Traces", metrics: "Metrics", code: "Code", provider: "Provider" }[kind];
}
