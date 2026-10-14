import { apiErrorMessage } from "./agents-api";
import type {
  TelemetryAlert,
  TelemetryAlertEpisode,
  TelemetryAlertSlackChannel,
  TelemetryAlertSummary,
} from "../../../packages/core/src/db/telemetry-alerts";
import type {
  AlertAggregation,
  AlertComparator,
  AlertEvaluation,
  AlertFilter,
  AlertSource,
  AlertUpdate,
} from "../../../packages/core/src/telemetry/alerts";
import type { ChartData } from "./dashboards-api";
import { metricPickerChoice, metricPickerOptions, metricPickerValue } from "./metric-picker";

export type {
  AlertComparator,
  AlertEvaluation,
  AlertSource,
  AlertUpdate,
  TelemetryAlert,
  TelemetryAlertEpisode,
  TelemetryAlertSlackChannel,
  TelemetryAlertSummary,
};

const base = "/api/telemetry/alerts";

async function request<T>(url: string, init?: { body?: unknown; method?: string }): Promise<T> {
  const response = await fetch(url, {
    ...(init?.method ? { method: init.method } : {}),
    ...(init?.body === undefined
      ? {}
      : { body: JSON.stringify(init.body), headers: { "content-type": "application/json" } }),
  });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body as T;
}

// Null when the workspace cannot use alerts.
export async function fetchAlerts(): Promise<TelemetryAlertSummary[] | null> {
  const response = await fetch(base);
  if (response.status === 404) return null;
  const body = (await response.json().catch(() => null)) as { alerts: TelemetryAlertSummary[] } | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body?.alerts ?? [];
}

export function fetchAlert(alertId: string): Promise<{ alert: TelemetryAlert; episodes: TelemetryAlertEpisode[] }> {
  return request(`${base}/${encodeURIComponent(alertId)}`);
}

export async function createAlert(input: AlertUpdate & { projectId: string }): Promise<TelemetryAlert> {
  return (await request<{ alert: TelemetryAlert }>(base, { body: input, method: "POST" })).alert;
}

export async function updateAlert(alertId: string, input: AlertUpdate): Promise<TelemetryAlert> {
  return (await request<{ alert: TelemetryAlert }>(`${base}/${encodeURIComponent(alertId)}`, { body: input, method: "PUT" })).alert;
}

export function deleteAlert(alertId: string): Promise<void> {
  return request(`${base}/${encodeURIComponent(alertId)}`, { method: "DELETE" });
}

// The rule's current value per group, and a chart of its recent windows. The
// server reads only the rule's fields.
export function previewAlert(
  input: AlertUpdate & { projectId: string },
): Promise<{ chart: ChartData; evaluations: AlertEvaluation[] }> {
  return request(`${base}/preview`, { body: input, method: "POST" });
}

export async function fetchAlertSlackChannels(refresh = false): Promise<TelemetryAlertSlackChannel[]> {
  const body = await request<{ channels: TelemetryAlertSlackChannel[] }>(
    `${base}/slack-channels${refresh ? "/refresh" : ""}`,
    refresh ? { method: "POST" } : undefined,
  );
  return body.channels;
}

// The alert editor's form. Text fields hold what is typed until saved.
export interface AlertForm {
  aggregation: AlertAggregation;
  comparator: AlertComparator;
  enabled: boolean;
  // Filter fields the form does not edit, kept from a copied Superlog alert.
  extraFilter: Pick<AlertFilter, "minDurationMs" | "spanName" | "statusCode">;
  filters: NonNullable<AlertFilter["resourceAttrs"]>;
  groupBy: string;
  intervalSeconds: number;
  // With the name, the one metric read; empty and null read every kind and
  // unit, as a metric picked by name does.
  metricKind: NonNullable<AlertFilter["metricKind"]> | "";
  metricName: string;
  metricUnit: string | null;
  name: string;
  perGroup: boolean;
  projectId: string;
  service: string;
  severity: string;
  // "integrationAccountId:channelId", or "" for no channel.
  slack: string;
  source: AlertSource;
  // Spans with an error status only.
  spanErrors: boolean;
  threshold: string;
  windowMinutes: number;
}

export function emptyAlertForm(projectId: string): AlertForm {
  return {
    aggregation: "count",
    comparator: "gt",
    enabled: true,
    extraFilter: {},
    filters: [],
    groupBy: "",
    intervalSeconds: 60,
    metricKind: "",
    metricName: "",
    metricUnit: null,
    name: "",
    perGroup: false,
    projectId,
    service: "",
    severity: "ERROR",
    slack: "",
    source: "logs",
    spanErrors: true,
    threshold: "",
    windowMinutes: 5,
  };
}

export function alertForm(alert: TelemetryAlert): AlertForm {
  const { metricKind, metricUnit, minDurationMs, resourceAttrs, service, severity, spanName, statusCode } = alert.filter;
  return {
    aggregation: alert.aggregation,
    comparator: alert.comparator,
    enabled: alert.enabled,
    extraFilter: {
      ...(minDurationMs !== undefined ? { minDurationMs } : {}),
      ...(spanName ? { spanName } : {}),
      // Another status, such as OK, is kept as it was.
      ...(statusCode && statusCode !== "STATUS_CODE_ERROR" ? { statusCode } : {}),
    },
    filters: resourceAttrs ?? [],
    groupBy: alert.groupBy ?? "",
    intervalSeconds: alert.evaluationIntervalSeconds,
    metricKind: metricKind ?? "",
    metricName: alert.metricName ?? "",
    metricUnit: metricUnit ?? null,
    name: alert.name,
    perGroup: alert.groupMode === "per_group",
    projectId: alert.projectId,
    service: service ?? "",
    severity: severity?.toUpperCase() ?? "",
    slack: alert.slack ? `${alert.slack.integrationAccountId}:${alert.slack.channelId}` : "",
    source: alert.source,
    spanErrors: statusCode === "STATUS_CODE_ERROR",
    threshold: String(alert.threshold),
    windowMinutes: alert.windowMinutes,
  };
}

type AlertMetric = Pick<AlertForm, "metricKind" | "metricName" | "metricUnit">;

export function alertMetricValue(metric: AlertMetric): string {
  return metricPickerValue({ kind: metric.metricKind, name: metric.metricName, unit: metric.metricUnit });
}

export function alertMetricChoice(value: string): AlertMetric {
  const { kind, name, unit } = metricPickerChoice(value);
  return { metricKind: kind, metricName: name, metricUnit: unit };
}

export const alertMetricOptions = metricPickerOptions;

// The rule a form describes, or what to fix first.
export function alertRequest(form: AlertForm): { error: string } | { body: AlertUpdate & { projectId: string } } {
  if (!form.name.trim()) return { error: "Name the alert." };
  const threshold = Number(form.threshold);
  if (form.threshold.trim() === "" || !Number.isFinite(threshold)) return { error: "Set a threshold." };
  if (form.source === "metric" && !form.metricName) return { error: "Choose a metric." };
  if (form.perGroup && !form.groupBy) return { error: "Choose what to group by." };
  const filters = form.filters.filter((filter) => filter.key.trim());
  const [integrationAccountId, channelId] = form.slack ? form.slack.split(":") : [];
  const filter: AlertFilter = {
    ...form.extraFilter,
    ...(filters.length > 0 ? { resourceAttrs: filters } : {}),
    ...(form.service ? { service: form.service } : {}),
    ...(form.source === "logs" && form.severity ? { severity: form.severity } : {}),
    ...(form.source === "traces" && form.spanErrors ? { statusCode: "STATUS_CODE_ERROR" } : {}),
    ...(form.source === "metric" && form.metricKind ? { metricKind: form.metricKind } : {}),
    ...(form.source === "metric" && form.metricUnit !== null ? { metricUnit: form.metricUnit } : {}),
  };
  if (form.source !== "traces") {
    delete filter.minDurationMs;
    delete filter.spanName;
    delete filter.statusCode;
  }
  return {
    body: {
      aggregation: form.source === "metric" ? (form.aggregation === "count" ? "avg" : form.aggregation) : "count",
      comparator: form.comparator,
      enabled: form.enabled,
      evaluationIntervalSeconds: form.intervalSeconds,
      filter,
      groupBy: form.groupBy || null,
      groupMode: form.perGroup ? "per_group" : "single",
      metricName: form.source === "metric" ? form.metricName : null,
      name: form.name.trim(),
      projectId: form.projectId,
      slack: integrationAccountId && channelId ? { channelId, integrationAccountId } : null,
      source: form.source,
      threshold,
      windowMinutes: form.windowMinutes,
    },
  };
}
