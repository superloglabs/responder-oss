import { useEffect, useState } from "react";
import { useDocumentTitle } from "../use-document-title";
import { ChartLegend, SignalChart } from "./charts";
import { chartMax, fetchUsage, shortDate, usageTotals, type SignalPeriod, type SignalUsageDay } from "./model";
import { PeriodSelect } from "./shared";

export function SignalUsage() {
  useDocumentTitle("Signal · Usage");
  const [days, setDays] = useState<SignalPeriod>(14);
  // Each result keeps the period it was loaded for; another period is loading.
  const [result, setResult] = useState<{ days: SignalPeriod; daily?: SignalUsageDay[]; error?: string } | null>(null);
  useEffect(() => {
    let current = true;
    fetchUsage(days)
      .then((usage) => { if (current) setResult({ days, daily: usage.daily }); })
      .catch((failure: unknown) => {
        if (current) setResult({ days, error: failure instanceof Error ? failure.message : "Could not load usage." });
      });
    return () => { current = false; };
  }, [days]);

  const error = result?.days === days ? result.error : undefined;
  const daily = result?.daily;
  if (!daily) {
    return error ? <p className="signalError" role="alert">{error}</p> : <p className="signalLoading" role="status">Loading…</p>;
  }
  const { total, accepted, acceptedPercent } = usageTotals(daily);
  const points = daily.map((day) => ({ label: shortDate(new Date(day.date)), value: day.total, accepted: day.accepted }));
  const legend = <>
    <ChartLegend label="Not yet accepted" value={total - accepted} suffix={`${(100 - acceptedPercent).toFixed(1)}%`} neutral />
    <ChartLegend label="Accepted findings" value={accepted} suffix={`${acceptedPercent.toFixed(1)}%`} />
  </>;
  return <section className="signalUsage">
    <header className="signalPageHeader">
      <div><h1>Usage</h1><p>{points[0]?.label} – {points.at(-1)?.label}</p></div>
      <PeriodSelect days={days} onChange={setDays} />
    </header>
    {error && <p className="signalError" role="alert">{error}</p>}
    <div className="signalCharts">
      <SignalChart title="Daily findings" max={chartMax(daily.map((day) => day.total))} points={points} footer={legend} />
      <section className="signalChart signalPeriod"><header><h2>Entire period</h2><span>{total} findings</span></header>
        <div className="signalPeriodBar" role="img" aria-label={`${total} findings: ${accepted} accepted, ${total - accepted} not yet accepted`}>
          <span style={{ width: `${total ? 100 - acceptedPercent : 100}%` }} /><span style={{ width: `${acceptedPercent}%` }} />
        </div><div className="signalChartFooter">{legend}</div>
      </section>
    </div>
  </section>;
}
