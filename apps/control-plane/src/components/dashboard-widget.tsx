import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import { Link } from "react-router-dom";
import { Badge } from "../design-system";
import {
  fetchWidgetData,
  type DashboardWidgetConfig,
  type DashboardWidgetType,
  type WidgetData,
} from "../dashboards-api";
import {
  formatDuration,
  formatTelemetryTime,
  severityTone,
  traceHref,
  type TelemetryRange,
} from "../telemetry-api";
import { TimeseriesChart } from "./timeseries-chart";

type DataWidgetType = Exclude<DashboardWidgetType, "markdown">;

function useWidgetData(input: {
  config: DashboardWidgetConfig;
  projectId: string;
  range: TelemetryRange;
  refresh: number;
  type: DataWidgetType;
  variables: Record<string, string>;
}) {
  const [state, setState] = useState<{ data: WidgetData | null; error: string | null; key: string }>({
    data: null,
    error: null,
    key: "",
  });
  // Refetch when anything the query depends on changes, or on refresh.
  const key = JSON.stringify(input);
  useEffect(() => {
    let cancelled = false;
    const { config, projectId, range, type, variables } = JSON.parse(key) as typeof input;
    fetchWidgetData({ config, projectId, range, type, variables })
      .then((data) => { if (!cancelled) setState({ data, error: null, key }); })
      .catch((cause: unknown) => {
        if (!cancelled) setState({ data: null, error: cause instanceof Error ? cause.message : "Unable to load", key });
      });
    return () => { cancelled = true; };
  }, [key]);
  // Keep showing the previous data while a refresh loads.
  return { ...state, loading: state.key !== key };
}

function WidgetData({
  config,
  projectId,
  range,
  refresh,
  title,
  type,
  variables,
}: {
  config: DashboardWidgetConfig;
  projectId: string;
  range: TelemetryRange;
  refresh: number;
  title: string;
  type: DataWidgetType;
  variables: Record<string, string>;
}) {
  const { data, error, loading } = useWidgetData({ config, projectId, range, refresh, type, variables });
  if (error) return <p className="dashboardWidget__status" role="alert">{error}</p>;
  if (!data) return <p className="dashboardWidget__status">{loading ? "Loading…" : ""}</p>;
  if (data.kind === "chart") {
    if (data.chart.series.length === 0) return <p className="dashboardWidget__status">No data in this time range.</p>;
    return (
      <TimeseriesChart
        chart={data.chart}
        chartType={config.chartType ?? (type === "timeseries_metric" ? "line" : "bar")}
        label={title}
        legendPosition={config.legendPosition ?? "bottom"}
        showLegend={config.showLegend ?? true}
        showXAxis={config.showXAxis ?? true}
        showYAxis={config.showYAxis ?? true}
        unit={config.unit ?? "none"}
      />
    );
  }
  if (data.kind === "logs") {
    if (data.logs.length === 0) return <p className="dashboardWidget__status">No logs in this time range.</p>;
    return (
      <table className="dashboardWidget__table">
        <thead><tr><th scope="col">Time</th><th scope="col">Level</th><th scope="col">Service</th><th scope="col">Message</th></tr></thead>
        <tbody>
          {data.logs.map((log, index) => (
            <tr key={`${log.timestamp}-${index}`}>
              <td className="dashboardWidget__muted">{formatTelemetryTime(log.timestamp)}</td>
              <td><Badge tone={severityTone(log.severity_number)}>{log.severity || "Unset"}</Badge></td>
              <td className="dashboardWidget__muted">{log.service || "—"}</td>
              <td className="dashboardWidget__mono" title={log.body}>
                {log.trace_id ? <Link to={traceHref(projectId, log.trace_id)}>{log.body}</Link> : log.body}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (data.traces.length === 0) return <p className="dashboardWidget__status">No traces in this time range.</p>;
  return (
    <table className="dashboardWidget__table">
      <thead><tr><th scope="col">Started</th><th scope="col">Service</th><th scope="col">Root span</th><th className="dashboardWidget__number" scope="col">Duration</th></tr></thead>
      <tbody>
        {data.traces.map((trace) => (
          <tr key={trace.trace_id}>
            <td className="dashboardWidget__muted">{formatTelemetryTime(trace.start_time)}</td>
            <td className="dashboardWidget__muted">{trace.root_service || "—"}</td>
            <td className="dashboardWidget__mono">
              <Link title={trace.root_span_name} to={traceHref(projectId, trace.trace_id)}>{trace.root_span_name || trace.trace_id}</Link>
            </td>
            <td className={Number(trace.error_count) > 0 ? "dashboardWidget__number dashboardWidget__error" : "dashboardWidget__number"}>
              {formatDuration(trace.duration_ms)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// The content of one widget: a chart, a table, or a note.
export function DashboardWidgetBody(props: {
  config: DashboardWidgetConfig;
  projectId: string;
  range: TelemetryRange;
  refresh: number;
  title: string;
  type: DashboardWidgetType;
  variables: Record<string, string>;
}) {
  if (props.type === "markdown") {
    return (
      <div className="dashboardWidget__markdown">
        <Markdown>{props.config.markdown ?? ""}</Markdown>
      </div>
    );
  }
  return <WidgetData {...props} type={props.type} />;
}
