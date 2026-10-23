import { histogramBars, type TraceOverview } from "../telemetry-api";

export function traceOverviewMetricBars(response: {
  overview: Pick<TraceOverview, "series">;
  since: string;
  until: string;
  stepMs: number;
}) {
  const requests = histogramBars(
    { ...response, buckets: response.overview.series.map((row) => ({ bucket: row.bucket, count: row.requests, group: "requests" })) },
    ["requests"],
    () => "requests",
  );
  const makeBars = (value: (row: TraceOverview["series"][number]) => number) => histogramBars(
    {
      buckets: response.overview.series.map((row) => ({ bucket: row.bucket, count: value(row), group: "value" })),
      since: response.since,
      stepMs: response.stepMs,
      until: response.until,
    },
    ["value"],
    () => "value",
  ).map((bar, index) => ({ ...bar, hasData: requests[index]!.total > 0 }));
  return {
    errorRate: makeBars((row) => row.requests ? (row.errors / row.requests) * 100 : 0),
    latency: makeBars((row) => row.p95_ms),
  };
}
