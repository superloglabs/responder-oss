import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { IconCopy, IconFlag, IconSearch } from "@tabler/icons-react";
import { Button } from "../design-system";
import { useDocumentTitle } from "../use-document-title";
import { ChartLegend, SignalChart } from "./charts";
import { findingPrompt, sampleFindings, shortDate, useSignalPreview } from "./model";
import { PeriodSelect, Severity } from "./shared";

export function SignalFindings() {
  useDocumentTitle("Signal · Findings");
  const [search, setSearch] = useState("");
  const [days, setDays] = useState(14);
  const [limit, setLimit] = useState(9);
  const matches = sampleFindings.filter((f) => f.title.toLowerCase().includes(search.toLowerCase()) && f.date.getTime() >= Date.UTC(2026, 10, 7 - days));
  const visible = matches.slice(0, limit);
  const groups = [...new Set(visible.map((f) => f.date.toISOString()))];
  return <section className="signalFindings">
    <h1 className="signalListHeading"><IconFlag size={16} stroke={2} />Findings</h1>
    <div className="signalFilters"><label className="signalSearch"><IconSearch size={14} /><input aria-label="Search findings" placeholder="Search findings…" value={search} onChange={(e) => { setSearch(e.target.value); setLimit(9); }} /></label><PeriodSelect days={days} onChange={(value) => { setDays(value); setLimit(9); }} /></div>
    {groups.map((group) => <section className="signalFindingGroup" key={group}>
      <h2>{group.startsWith("2026-11-06") ? "Today" : group.startsWith("2026-11-05") ? "Yesterday" : shortDate(new Date(group))}</h2>
      <div className="signalTableSurface"><table><colgroup><col className="signalFindingTitleColumn" /><col /><col /></colgroup>
        <thead><tr><th scope="col">Finding</th><th scope="col">Severity</th><th scope="col">Found</th></tr></thead>
        <tbody>{visible.filter((f) => f.date.toISOString() === group).map((f) => <tr key={f.id}>
          <td><Link to={`/signal/findings/${f.id}`}>{f.title}</Link></td><td><Severity level={f.severity} /></td><td>{f.found}</td>
        </tr>)}</tbody>
      </table></div>
    </section>)}
    {!matches.length && <div className="signalEmpty"><h2>No matching findings</h2><p>Try another search or date range.</p><Button onClick={() => { setSearch(""); setDays(14); }}>Clear filters</Button></div>}
    <footer className="signalListFooter"><span>Showing {visible.length} of {matches.length} findings</span>{limit < matches.length && <Button onClick={() => setLimit((n) => n + 9)}>Load more</Button>}</footer>
  </section>;
}
export function SignalFindingDetail() {
  const { findingId } = useParams();
  const finding = sampleFindings.find((f) => f.id === findingId);
  useDocumentTitle(finding ? `Signal · ${finding.id}` : "Signal · Finding not found");
  const { preview, setPreview } = useSignalPreview();
  const [copyStatus, setCopyStatus] = useState("");
  if (!finding) return <section className="signalEmpty"><h1>Finding not found</h1><Link to="/signal/findings">Back to findings</Link></section>;
  const irrelevant = preview.irrelevant.includes(finding.id);
  const checkout = finding.id === "SIG-042";
  async function copyPrompt() {
    try { await navigator.clipboard.writeText(findingPrompt(finding!)); setCopyStatus("Prompt copied"); }
    catch { setCopyStatus("Could not copy. Select and copy the summary instead."); }
  }
  return <article className="signalDetail">
    <header>
      <nav className="workspaceBreadcrumb" aria-label="Breadcrumb"><Link to="/signal/findings">Findings</Link><span aria-hidden="true">›</span><span>{finding.id}</span></nav>
      <div className="signalDetailHeader"><div><h1>{finding.title}</h1><p>{finding.summary}</p></div>
        <div className="signalDetailActions"><Button onClick={() => setPreview((state) => ({ ...state, irrelevant: irrelevant ? state.irrelevant.filter((id) => id !== finding.id) : [...state.irrelevant, finding.id] }))}>{irrelevant ? "Restore finding" : "Mark as irrelevant"}</Button><Button variant="primary" onClick={() => void copyPrompt()}><IconCopy size={14} />Copy prompt</Button></div>
      </div><span className="signalCopyStatus" role="status">{copyStatus}</span>
    </header>
    <div className="signalDetailColumns">
      <div className="signalDetailMain"><section><h2>Root cause</h2><p>{finding.cause}</p></section>
        <section className="signalEvidence"><h2>Evidence</h2>
          <SignalChart title={checkout ? "Checkout timeouts" : "Affected requests"} max={6} points={[0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 4, 5].map((value, i) => ({ label: `${14 + Math.floor(i / 6)}:${String(i % 6 * 10).padStart(2, "0")}`, value }))} footer={<><ChartLegend label={checkout ? "Checkout 504s" : "Failed requests"} value={18} /><span className="signalChartNote">10-minute buckets · UTC</span></>} />
          <SignalChart title="Request duration · p95" max={30} unit="s" line threshold={20} points={[1.1, 1.2, 1, 1.1, 1.3, 4.2, 9.8, 14.7, 18.1, 22.4, 26.8, 29.6].map((value, i) => ({ label: `${14 + Math.floor(i / 6)}:${String(i % 6 * 10).padStart(2, "0")}`, value }))} footer={<><ChartLegend label="p95 duration" value="29.6s" /><ChartLegend label="Gateway deadline" value="20s" neutral /></>} />
          {checkout && <section className="signalCode"><header><h3>Retry configuration</h3><span>src/payments/client.ts · a4f29c1</span></header>
            <div className="signalCodeBody"><pre aria-hidden="true">41{"\n"}42{"\n"}43{"\n"}44</pre><pre><code><b>const</b> paymentClient = <b>new</b> PaymentClient({"{"}{"\n"}{"  "}timeout: <b>10_000</b>,{"\n"}{"  "}maxRetries: <b>2</b>,{"\n"}{"}"});</code></pre></div>
          </section>}
          <section className="signalCode"><header><h3>Gateway log</h3><span>Datadog · Nov 6, 15:43:08 UTC</span></header><pre className="signalLog"><code><em>ERROR</em> {finding.service} · Request timed out{"\n"}status=504 duration_ms=20000 retry_attempt=2{"\n"}max_retries=2 trace_id=8d7c2a9e</code></pre></section>
        </section>
      </div>
      <aside className="signalProperties"><h2>Properties</h2><dl>
        <dt>Severity</dt><dd><Severity level={finding.severity} /></dd><dt>Status</dt><dd>{irrelevant ? "Irrelevant" : finding.accepted ? "Accepted" : "New"}</dd>
        <dt>Source</dt><dd>Datadog</dd><dt>Found</dt><dd>{finding.found}</dd><dt>Service</dt><dd>{finding.service}</dd><dt>Channel</dt><dd>#{preview.channel}</dd>
      </dl></aside>
    </div>
  </article>;
}
