import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { IconArrowUpRight } from "@tabler/icons-react";
import { Badge } from "../design-system";
import { AttributeTable, ExplorerDrawer } from "../components/telemetry-explorer";
import { TimeseriesChart } from "../components/timeseries-chart";
import { TraceDrawer } from "../components/trace-drawer";
import { formatDuration, formatTelemetryTime, severityTextTone, traceHref } from "../telemetry-api";
import {
  evidenceLink,
  type SignalEvidence,
  type SignalEvidenceLog,
  type SignalEvidenceSpan,
  type SignalEvidenceView,
} from "./model";

const kindLabels: Record<SignalEvidence["kind"], string> = {
  logs: "Logs",
  traces: "Traces",
  metrics: "Metrics",
  code: "Code",
  provider: "Provider",
};

// A row opened in the drawer, with where it came from.
type OpenRow =
  | { type: "log"; row: SignalEvidenceLog; source: string }
  | { type: "span"; row: SignalEvidenceSpan; source: string }
  | { type: "table"; columns: string[]; row: Array<string | number | null>; source: string };

// One piece of evidence: what the cited query returned, as charts or rows,
// then the agent's note on it.
export function EvidenceItem({ item }: { item: SignalEvidence }) {
  const [open, setOpen] = useState<OpenRow | null>(null);
  const data = item.data;
  const link = evidenceLink(data?.url ?? null);
  const source = data?.source ?? null;
  return <section className="signalCode signalEvidenceItem">
    <header>
      <h3>{item.title}</h3>
      <span className="signalEvidenceSource">
        {source && source !== kindLabels[item.kind] ? `${kindLabels[item.kind]} · ${source}` : kindLabels[item.kind]}
        {link && source && <SourceLink link={link} source={source} />}
      </span>
    </header>
    {data?.views.map((view, index) => <div className="signalEvidenceView" key={index}>
      <EvidenceView onOpen={setOpen} source={data.source} view={view} />
    </div>)}
    <pre className="signalLog"><code>{item.detail}</code></pre>
    {open && <RowDrawer onClose={() => setOpen(null)} open={open} />}
  </section>;
}

function SourceLink({ link, source }: { link: { internal: boolean; href: string }; source: string }) {
  const label = <>Open in {source}<IconArrowUpRight aria-hidden="true" size={12} /></>;
  return link.internal
    ? <Link className="signalEvidenceLink" to={link.href}>{label}</Link>
    : <a className="signalEvidenceLink" href={link.href} rel="noreferrer" target="_blank">{label}</a>;
}

function EvidenceView({ onOpen, source, view }: { onOpen: (row: OpenRow) => void; source: string; view: SignalEvidenceView }) {
  if (view.type === "chart") {
    return <figure className="signalEvidenceChart">
      <figcaption>{view.title}</figcaption>
      <div className="signalEvidenceChart__plot">
        <TimeseriesChart
          chart={{ buckets: view.buckets, stepMs: view.stepMs, series: view.series.map((series) => ({ ...series, other: false })) }}
          chartType="line"
          density="compact"
          label={view.title}
          showLegend={view.series.length > 1}
          unit={view.unit}
        />
      </div>
    </figure>;
  }
  if (view.type === "logs") {
    return <RowTable
      headings={["Time", "Level", "Service", "Message"]}
      rows={view.rows.map((row) => ({
        cells: [time(row.timestamp), row.severity ? <Badge tone={severityTextTone(row.severity)}>{row.severity}</Badge> : "—", row.service || "—", row.message],
        open: () => onOpen({ type: "log", row, source }),
        label: row.message,
      }))}
    />;
  }
  if (view.type === "spans") {
    return <RowTable
      headings={["Time", "Service", "Span", "Duration", "Status"]}
      rows={view.rows.map((row) => ({
        cells: [time(row.timestamp), row.service || "—", row.name || "—", row.durationMs === null ? "—" : formatDuration(row.durationMs), row.status || "—"],
        open: () => onOpen({ type: "span", row, source }),
        label: row.name || row.traceId || "span",
      }))}
    />;
  }
  return <RowTable
    headings={view.columns}
    rows={view.rows.map((row) => ({
      cells: row.map((value) => value === null ? "—" : typeof value === "number" ? value.toLocaleString() : value),
      open: () => onOpen({ type: "table", columns: view.columns, row, source }),
      label: String(row[0] ?? "row"),
    }))}
  />;
}

function time(value: string | null): string {
  return value ? formatTelemetryTime(value) : "—";
}

// A compact table whose rows open in the drawer.
function RowTable({ headings, rows }: { headings: string[]; rows: Array<{ cells: ReactNode[]; open: () => void; label: string }> }) {
  return <div className="signalEvidenceTable">
    <table>
      <thead><tr>{headings.map((heading) => <th key={heading} scope="col">{heading}</th>)}</tr></thead>
      <tbody>
        {rows.map((row, index) => <tr
          aria-label={`Open ${row.label}`}
          key={index}
          onClick={row.open}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              row.open();
            }
          }}
          tabIndex={0}
        >
          {row.cells.map((value, column) => <td key={column} title={typeof value === "string" ? value : undefined}>{value}</td>)}
        </tr>)}
      </tbody>
    </table>
  </div>;
}

function RowDrawer({ onClose, open }: { onClose: () => void; open: OpenRow }) {
  // A Superlog span opens the whole trace, as the trace list does.
  if (open.type === "span" && open.source === "Superlog" && open.row.traceId) {
    return <TraceDrawer listState={{ traceList: "" }} onClose={onClose} traceId={open.row.traceId} />;
  }
  const traceId = open.type === "table" ? null : open.row.traceId;
  const fields = open.type === "table"
    ? Object.fromEntries(open.columns.map((column, index) => [column, open.row[index] === null || open.row[index] === undefined ? "" : String(open.row[index])]).filter(([, value]) => value !== ""))
    : open.row.fields;
  const leading: Array<{ key: string; value: ReactNode }> = [];
  if (open.type === "log") {
    if (open.row.timestamp) leading.push({ key: "Time", value: time(open.row.timestamp) });
    if (open.row.severity) leading.push({ key: "Level", value: open.row.severity });
    if (open.row.service) leading.push({ key: "Service", value: open.row.service });
    leading.push({ key: "Message", value: <span className="signalEvidenceMessage">{open.row.message}</span> });
  }
  if (open.type === "span") {
    if (open.row.timestamp) leading.push({ key: "Time", value: time(open.row.timestamp) });
    if (open.row.name) leading.push({ key: "Span", value: open.row.name });
    if (open.row.service) leading.push({ key: "Service", value: open.row.service });
    if (open.row.durationMs !== null) leading.push({ key: "Duration", value: formatDuration(open.row.durationMs) });
    if (open.row.status) leading.push({ key: "Status", value: open.row.status });
  }
  if (traceId && open.source === "Superlog") leading.push({ key: "Trace", value: <Link to={traceHref(traceId)}>{traceId}</Link> });
  const title = open.type === "log" ? "Log" : open.type === "span" ? "Span" : "Row";
  return <ExplorerDrawer
    header={<strong className="signalEvidenceDrawer__title">{title} from {open.source}</strong>}
    label={`${title} details`}
    onClose={onClose}
  >
    <AttributeTable grouped leading={leading} scopes={[{ heading: "Fields", label: "Fields", prefix: "", values: fields }]} />
  </ExplorerDrawer>;
}
