import { expect, it } from "vitest";
import { traceOverviewMetricBars } from "./traces-overview-charts";

it("distinguishes empty buckets from observed zero metrics", () => {
  const charts = traceOverviewMetricBars({
    since: "2026-10-23T12:00:00Z",
    until: "2026-10-23T12:03:00Z",
    stepMs: 60_000,
    overview: { series: [
      { bucket: "2026-10-23T12:00:00Z", requests: 10, errors: 0, p95_ms: 0 },
      { bucket: "2026-10-23T12:02:00Z", requests: 0, errors: 0, p95_ms: 0 },
      { bucket: "2026-10-23T12:03:00Z", requests: 20, errors: 2, p95_ms: 1500 },
    ] },
  });
  for (const bars of [charts.errorRate, charts.latency]) {
    expect(bars.map((bar) => bar.hasData)).toEqual([true, false, false, true]);
  }
  expect(charts.errorRate.map((bar) => bar.total)).toEqual([0, 0, 0, 10]);
  expect(charts.latency.map((bar) => bar.total)).toEqual([0, 0, 0, 1500]);
});
