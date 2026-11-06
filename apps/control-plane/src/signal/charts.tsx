import { useState, type ReactNode } from "react";

export interface ChartPoint { label: string; value: number; accepted?: number }
export function SignalChart({ title, points, max, unit = "", line = false, threshold, footer }: {
  title: string; points: ChartPoint[]; max: number; unit?: string; line?: boolean; threshold?: number; footer: ReactNode;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const point = hovered === null ? null : points[hovered];
  const step = 1000 / points.length;
  const y = (v: number) => 80 - v / max * 72;
  return <section className="signalChart">
    <h2>{title}</h2>
    <div className="signalChartPlot">
      <div className="signalChartAxis">{[max, max * 2 / 3, max / 3, 0].map((n) => <span key={n}>{Math.round(n)}{unit}</span>)}</div>
      <div className="signalChartCanvas">
        <svg aria-label={title} role="img" viewBox="0 0 1000 88" preserveAspectRatio="none">
          <title>{title}</title>
          <desc>{points.map((p) => `${p.label}: ${p.value}${unit}${p.accepted === undefined ? "" : `, ${p.accepted} accepted`}`).join("; ")}</desc>
          {[8, 32, 56, 80].map((v) => <line key={v} x1={0} x2={1000} y1={v} y2={v} stroke="var(--signal-grid)" vectorEffect="non-scaling-stroke" />)}
          {threshold !== undefined && <line x1={0} x2={1000} y1={y(threshold)} y2={y(threshold)} stroke="#a4a4a4" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />}
          {line ? <path d={points.map((p, i) => `${i ? "L" : "M"}${i * 1000 / (points.length - 1)},${y(p.value)}`).join(" ")} fill="none" stroke="var(--signal-accent)" strokeWidth={1.3} vectorEffect="non-scaling-stroke" />
            : points.map((p, i) => {
              const accepted = p.accepted ?? p.value;
              return <g key={p.label}>
                <rect x={i * step + step * .35} y={y(p.value - accepted)} width={step * .3} height={(p.value - accepted) / max * 72} fill="var(--signal-neutral)" />
                <rect x={i * step + step * .35} y={y(p.value)} width={step * .3} height={accepted / max * 72} fill="var(--signal-accent)" />
              </g>;
            })}
        </svg>
        <div className="signalChartTargets">{points.map((p, i) => <button key={p.label} type="button" aria-label={`${p.label}: ${p.value}${unit}${p.accepted === undefined ? "" : `, ${p.accepted} accepted`}`} onFocus={() => setHovered(i)} onBlur={() => setHovered(null)} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)} onKeyDown={(e) => { if (e.key === "Escape") setHovered(null); }} />)}</div>
        <div className="signalChartDates">{points.map((p, i) => <span key={p.label}>{points.length <= 7 || i % Math.ceil(points.length / 7) === 0 || i === points.length - 1 ? p.label : ""}</span>)}</div>
        {point && <div className="signalChartTooltip" role="tooltip" style={{ left: `${Math.min(75, Math.max(0, (hovered ?? 0) / points.length * 100))}%` }}>
          {point.accepted !== undefined && <div><i className="signalSwatch signalSwatch--neutral" />Not yet accepted<strong>{point.value - point.accepted}</strong></div>}
          <div><i className="signalSwatch" />{point.accepted === undefined ? title : "Accepted"}<strong>{point.accepted ?? point.value}{unit}</strong></div>
          <small>{point.label}</small>
        </div>}
      </div>
    </div>
    <div className="signalChartFooter">{footer}</div>
  </section>;
}
export function ChartLegend({ label, value, neutral = false, suffix }: { label: string; value: string | number; neutral?: boolean; suffix?: string }) {
  return <div className="signalLegend"><i className={`signalSwatch${neutral ? " signalSwatch--neutral" : ""}`} /><span>{label}</span><strong>{value}{suffix && <small> {suffix}</small>}</strong></div>;
}

