import { useState } from "react";
import { useDocumentTitle } from "../use-document-title";
import { ChartLegend, SignalChart } from "./charts";
import { periodData, shortDate } from "./model";
import { PeriodSelect } from "./shared";

export function SignalUsage() {
  useDocumentTitle("Signal · Usage");
  const [days, setDays] = useState(14);
  const data = periodData(days);
  const total = data.reduce((n, point) => n + point.total, 0);
  const accepted = data.reduce((n, point) => n + point.accepted, 0);
  const percent = total ? accepted / total * 100 : 0;
  const legend = <><ChartLegend label="Not yet accepted" value={total - accepted} suffix={`${(100 - percent).toFixed(1)}%`} neutral /><ChartLegend label="Accepted findings" value={accepted} suffix={`${percent.toFixed(1)}%`} /></>;
  return <section className="signalUsage">
    <header className="signalPageHeader"><div><h1>Usage</h1><p>{shortDate(data[0].date)} – {shortDate(data.at(-1)!.date)}, 2026</p></div><PeriodSelect days={days} onChange={setDays} /></header>
    <div className="signalCharts">
      <SignalChart title="Daily findings" max={6} points={data.map((p) => ({ label: shortDate(p.date), value: p.total, accepted: p.accepted }))} footer={legend} />
      <section className="signalChart signalPeriod"><header><h2>Entire period</h2><span>{total} findings</span></header>
        <div className="signalPeriodBar" role="img" aria-label={`${total} findings: ${accepted} accepted, ${total - accepted} not yet accepted`}>
          <span style={{ width: `${100 - percent}%` }} /><span style={{ width: `${percent}%` }} />
        </div><div className="signalChartFooter">{legend}</div>
      </section>
    </div>
  </section>;
}

