import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { IconArrowUpRight } from "@tabler/icons-react";
import { AttributeTable, ExplorerDrawer } from "../components/telemetry-explorer";
import { TraceDrawer } from "../components/trace-drawer";
import { formatWidgetValue } from "../dashboards-api";
import { formatDuration, traceHref } from "../telemetry-api";
import {
  evidenceAxisLabel,
  evidenceAxisMax,
  evidenceBucketLabel,
  evidenceChartBars,
  evidenceLegendValue,
  evidenceLink,
  type SignalEvidence,
  type SignalEvidenceLog,
  type SignalEvidenceSpan,
  type SignalEvidenceView,
} from "./model";

type ChartView = Extract<SignalEvidenceView, { type: "chart" }>;

const kindLabels: Record<SignalEvidence["kind"], string> = {
  logs: "Logs",
  traces: "Traces",
  metrics: "Metrics",
  code: "Code",
  provider: "Provider",
};

// Line colors after the accent: the design's neutral gray, then distinct hues.
const seriesColors = ["var(--signal-accent)", "#a4a4a4", "#d97706", "#0f9f6e", "#d03b7f", "#7c5cd6", "#0e91b1", "#6b8e23"];

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
  const views = data?.views ?? [];
  const link = evidenceLink(data?.url ?? null);
  const single = views.length === 1 && views[0]!.type === "logs" && views[0]!.rows.length === 1 ? views[0]!.rows[0]! : null;
  return <section className="signalCode signalEvidenceItem">
    <header>
      <h3>{item.title}</h3>
      <span className="signalEvidenceSource">
        {data
          ? <>{link ? <SourceLink link={link} source={data.source} /> : data.source}{single?.timestamp && ` · ${utcTime(single.timestamp)}`}</>
          : kindLabels[item.kind]}
      </span>
    </header>
    {views.map((view, index) => <EvidenceView
      key={index}
      onOpen={setOpen}
      showTitle={views.filter((other) => other.type === "chart").length > 1}
      source={data!.source}
      view={view}
    />)}
    {views.length > 0
      ? <p className="signalEvidenceNote">{item.detail}</p>
      : <pre className="signalLog"><code>{item.detail}</code></pre>}
    {open && <RowDrawer onClose={() => setOpen(null)} open={open} />}
  </section>;
}

function SourceLink({ link, source }: { link: { internal: boolean; href: string }; source: string }) {
  const label = <>{source}<IconArrowUpRight aria-hidden="true" size={12} /></>;
  const title = `Open in ${source}`;
  return link.internal
    ? <Link aria-label={title} className="signalEvidenceLink" title={title} to={link.href}>{label}</Link>
    : <a aria-label={title} className="signalEvidenceLink" href={link.href} rel="noreferrer" target="_blank" title={title}>{label}</a>;
}

function EvidenceView({ onOpen, showTitle, source, view }: {
  onOpen: (row: OpenRow) => void;
  showTitle: boolean;
  source: string;
  view: SignalEvidenceView;
}) {
  if (view.type === "chart") return <EvidenceChart showTitle={showTitle} view={view} />;
  if (view.type === "logs") {
    const timed = view.rows.length > 1;
    return <div className="signalEvidenceLines">
      {view.rows.map((row, index) => <button className="signalEvidenceLine" key={index} onClick={() => onOpen({ type: "log", row, source })} type="button">
        <span className="signalEvidenceLine__main">
          {timed && row.timestamp && <span className="signalEvidenceLine__time" title={utcTime(row.timestamp)}>{clockTime(row.timestamp)}</span>}
          {row.severity && <span className={`signalEvidenceLevel signalEvidenceLevel--${levelTone(row.severity)}`}>{row.severity.toUpperCase()}</span>}
          {[row.service, row.message].filter(Boolean).join(" · ")}
        </span>
        <span className="signalEvidenceLine__fields">{fieldsLine(row.fields, [row.message])}</span>
      </button>)}
    </div>;
  }
  if (view.type === "spans") {
    return <div className="signalEvidenceLines">
      {view.rows.map((row, index) => <button className="signalEvidenceLine" key={index} onClick={() => onOpen({ type: "span", row, source })} type="button">
        <span className="signalEvidenceLine__main">
          {row.timestamp && <span className="signalEvidenceLine__time" title={utcTime(row.timestamp)}>{clockTime(row.timestamp)}</span>}
          {row.status && <span className={`signalEvidenceLevel signalEvidenceLevel--${levelTone(row.status)}`}>{row.status.toUpperCase()}</span>}
          {[row.service, row.name].filter(Boolean).join(" · ")}
          {row.durationMs !== null && <span className="signalEvidenceLine__duration">{formatDuration(row.durationMs)}</span>}
        </span>
        <span className="signalEvidenceLine__fields">{fieldsLine(row.fields, [])}</span>
      </button>)}
    </div>;
  }
  return <div className="signalEvidenceTable">
    <table>
      <thead><tr>{view.columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
      <tbody>
        {view.rows.map((row, index) => <tr
          aria-label={`Open row ${index + 1}`}
          key={index}
          onClick={() => onOpen({ type: "table", columns: view.columns, row, source })}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onOpen({ type: "table", columns: view.columns, row, source });
            }
          }}
          tabIndex={0}
        >
          {row.map((value, column) => {
            const shown = value === null ? "—" : typeof value === "number" ? value.toLocaleString() : value;
            return <td className={typeof value === "number" ? "signalEvidenceTable__number" : undefined} key={column} title={shown}>{shown}</td>;
          })}
        </tr>)}
      </tbody>
    </table>
  </div>;
}

// Signal's compact chart: four gridlines, an axis of round numbers, bars for
// one series of counts and lines otherwise, and a legend with each series'
// total or latest value.
function EvidenceChart({ showTitle, view }: { showTitle: boolean; view: ChartView }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const bars = evidenceChartBars(view);
  const count = view.buckets.length;
  const max = evidenceAxisMax(view.series.flatMap((series) => series.values));
  const y = (value: number) => 80 - value / max * 72;
  const x = (index: number) => count <= 1 ? 500 : index * 1000 / (count - 1);
  const step = 1000 / count;
  const labels = timeLabels(view.buckets);
  const legend = view.series.map((series, index) => ({
    name: series.name,
    color: seriesColors[index % seriesColors.length]!,
    value: evidenceLegendValue(series.values, bars),
  }));
  const bucketLabel = evidenceBucketLabel(view.stepMs);
  return <figure className="signalEvidenceChart">
    {showTitle && <figcaption>{view.title}</figcaption>}
    <div className="signalChartPlot">
      <div className="signalChartAxis">{[max, max * 2 / 3, max / 3, 0].map((tick) => <span key={tick}>{evidenceAxisLabel(tick, view.unit)}</span>)}</div>
      <div className="signalChartCanvas">
        <svg aria-label={view.title} role="img" viewBox="0 0 1000 88" preserveAspectRatio="none">
          <title>{view.title}</title>
          {[8, 32, 56, 80].map((line) => <line key={line} x1={0} x2={1000} y1={line} y2={line} stroke="var(--signal-grid)" vectorEffect="non-scaling-stroke" />)}
          {bars
            ? view.series[0]!.values.map((value, index) => value === null || value === 0 ? null : <rect
              fill="var(--signal-accent)"
              height={value / max * 72}
              key={index}
              width={step * .5}
              x={index * step + step * .25}
              y={y(value)}
            />)
            : view.series.map((series, index) => <path
              d={linePath(series.values, x, y)}
              fill="none"
              key={series.name}
              stroke={legend[index]!.color}
              strokeLinejoin="round"
              strokeWidth={1.3}
              vectorEffect="non-scaling-stroke"
            />)}
          {hovered !== null && !bars && <line stroke="#cfcfcf" vectorEffect="non-scaling-stroke" x1={x(hovered)} x2={x(hovered)} y1={4} y2={80} />}
        </svg>
        <div className="signalChartTargets">{view.buckets.map((bucket, index) => <button
          aria-label={`${utcDateTime(bucket)} UTC: ${view.series.map((series) => `${series.name} ${formatWidgetValue(series.values[index] ?? null, view.unit)}`).join(", ")}`}
          key={bucket}
          onBlur={() => setHovered(null)}
          onFocus={() => setHovered(index)}
          onKeyDown={(event) => { if (event.key === "Escape") setHovered(null); }}
          onMouseEnter={() => setHovered(index)}
          onMouseLeave={() => setHovered(null)}
          type="button"
        />)}</div>
        <div className="signalEvidenceDates">{labels.map((label) => <span key={label.index} style={{ left: `${count <= 1 ? 50 : label.index / (count - 1) * 100}%` }}>{label.text}</span>)}</div>
        {hovered !== null && <div className="signalChartTooltip" role="tooltip" style={{ left: `max(0px, min(${count <= 1 ? 0 : hovered / (count - 1) * 100}%, calc(100% - 202px)))` }}>
          {legend.map((series, index) => <div key={series.name}><i className="signalSwatch" style={{ background: series.color }} /><span className="signalEvidenceTooltipName">{series.name}</span><strong>{formatWidgetValue(view.series[index]!.values[hovered] ?? null, view.unit)}</strong></div>)}
          <small>{utcDateTime(view.buckets[hovered]!)} UTC</small>
        </div>}
      </div>
    </div>
    <div className="signalChartFooter signalEvidenceLegend">
      {legend.map((series) => <div className="signalLegend" key={series.name}>
        <i className="signalSwatch" style={{ background: series.color }} />
        <span className="signalEvidenceLegend__name" title={series.name}>{series.name}</span>
        <strong>{formatWidgetValue(series.value, view.unit)}</strong>
      </div>)}
      {legend.length === 1 && bucketLabel && <div className="signalChartNote">{bucketLabel} · UTC</div>}
    </div>
  </figure>;
}

// A line through the points, broken where a bucket has no value.
function linePath(values: ReadonlyArray<number | null>, x: (index: number) => number, y: (value: number) => number): string {
  let path = "";
  let drawing = false;
  values.forEach((value, index) => {
    if (value === null) {
      drawing = false;
      return;
    }
    path += `${drawing ? "L" : "M"}${x(index)},${y(value)} `;
    drawing = true;
  });
  return path.trim();
}

// About five evenly spaced time labels, always with the last bucket.
function timeLabels(buckets: number[]): Array<{ index: number; text: string }> {
  if (buckets.length === 0) return [];
  const span = buckets.at(-1)! - buckets[0]!;
  const every = Math.max(1, Math.ceil(buckets.length / 5));
  const indexes = buckets.map((_, index) => index).filter((index) => index % every === 0 && buckets.length - 1 - index >= every / 2);
  indexes.push(buckets.length - 1);
  return indexes.map((index) => ({
    index,
    text: span > 2 * 86_400_000
      ? new Date(buckets[index]!).toLocaleDateString(undefined, { timeZone: "UTC", day: "numeric", month: "short" })
      : new Date(buckets[index]!).toLocaleTimeString(undefined, { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false }),
  }));
}

function utcDateTime(time: number): string {
  return new Date(time).toLocaleString(undefined, { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function utcTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return `${new Date(time).toLocaleString(undefined, { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })} UTC`;
}

// 14:40:00, for rows whose full time is in their title and drawer.
function clockTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Date(time).toLocaleTimeString(undefined, { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function levelTone(level: string): "error" | "warning" | "plain" {
  const text = level.toUpperCase();
  if (text.startsWith("ERR") || text.startsWith("FATAL") || text.startsWith("CRIT")) return "error";
  if (text.startsWith("WARN")) return "warning";
  return "plain";
}

// A row's fields as key=value, without the ones already shown.
function fieldsLine(fields: Record<string, string>, shown: string[]): string {
  return Object.entries(fields)
    .filter(([, value]) => !shown.includes(value) && value.length <= 200)
    .slice(0, 8)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
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
    if (open.row.timestamp) leading.push({ key: "Time", value: utcTime(open.row.timestamp) });
    if (open.row.severity) leading.push({ key: "Level", value: open.row.severity });
    if (open.row.service) leading.push({ key: "Service", value: open.row.service });
    leading.push({ key: "Message", value: <span className="signalEvidenceMessage">{open.row.message}</span> });
  }
  if (open.type === "span") {
    if (open.row.timestamp) leading.push({ key: "Time", value: utcTime(open.row.timestamp) });
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
