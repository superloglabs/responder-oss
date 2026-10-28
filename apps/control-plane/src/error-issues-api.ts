import { apiErrorMessage } from "./agents-api";
import type {
  ErrorIssue,
  ErrorIssueDay,
  ErrorIssueHour,
  ErrorIssueSummary,
} from "../../../packages/core/src/db/error-issues";
import type { ErrorIssueStatus } from "../../../packages/core/src/telemetry/error-issues";
import type { ChartData } from "./dashboards-api";
import type { LogRecord } from "./telemetry-api";

export type { ErrorIssue, ErrorIssueDay, ErrorIssueHour, ErrorIssueStatus, ErrorIssueSummary };

// Hours are set when the list's counts are hourly.
export type ErrorIssueListItem = ErrorIssueSummary & { days: ErrorIssueDay[]; hours?: ErrorIssueHour[] };

export interface ErrorIssueList {
  counts: Record<ErrorIssueStatus, number>;
  environments: string[];
  issues: ErrorIssueListItem[];
  // Hourly for the last 24 hours, daily otherwise.
  interval: "day" | "hour";
  services: string[];
  // The first day, or for hourly counts the first hour, the counts cover.
  since: string;
}

export interface ErrorIssueDetail {
  hours?: ErrorIssueHour[];
  days: ErrorIssueDay[];
  issue: ErrorIssue;
  since: string;
}

export type ErrorIssueFilter = {
  before?: Pick<ErrorIssueSummary, "id" | "lastSeenAt"> & Partial<Pick<ErrorIssueSummary, "firstSeenAt" | "eventCount">>;
  sort?: "lastSeen" | "firstSeen" | "events";
  statuses?: ErrorIssueStatus[];
  services?: string[];
  environments?: string[];
  activity?: "active" | "inactive";
  range?: "24h" | "7d" | "14d" | "30d" | "all";
  search?: string;
  service?: string;
  status: ErrorIssueStatus | "all";
};

const base = "/api/error-issues";

async function request<T>(url: string, init?: { body?: unknown; method?: string }): Promise<T> {
  const response = await fetch(url, {
    ...(init?.method ? { method: init.method } : {}),
    ...(init?.body === undefined
      ? {}
      : { body: JSON.stringify(init.body), headers: { "content-type": "application/json" } }),
  });
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body as T;
}

export function errorIssueParams(filter: ErrorIssueFilter): URLSearchParams {
  const params = new URLSearchParams({ status: filter.status });
  for (const key of ["statuses", "services", "environments"] as const) {
    for (const value of filter[key] ?? []) params.append(key, value);
  }
  if (filter.sort) params.set("sort", filter.sort);
  if (filter.activity) params.set("activity", filter.activity);
  if (filter.range) params.set("range", filter.range);
  if (filter.service) params.set("service", filter.service);
  if (filter.search?.trim()) params.set("search", filter.search.trim());
  if (filter.before) {
    params.set("before", filter.before.lastSeenAt);
    params.set("beforeId", filter.before.id);
    if (filter.sort === "firstSeen" && filter.before.firstSeenAt) params.set("beforeFirstSeen", filter.before.firstSeenAt);
    if (filter.sort === "events" && filter.before.eventCount !== undefined) params.set("beforeEvents", String(filter.before.eventCount));
  }
  return params;
}

// Null when the workspace cannot use telemetry.
export async function fetchErrorIssues(filter: ErrorIssueFilter): Promise<ErrorIssueList | null> {
  const response = await fetch(`${base}?${errorIssueParams(filter)}`);
  if (response.status === 404) return null;
  const body = (await response.json().catch(() => null)) as ErrorIssueList | null;
  if (!response.ok || !body) throw new Error(apiErrorMessage(body, response.status));
  return body;
}

// The services the workspace's error issues came from.
export async function fetchErrorIssueServices(): Promise<string[]> {
  return (await request<{ services: string[] }>(`${base}/services`)).services;
}

export function fetchErrorIssue(issueId: string): Promise<ErrorIssueDetail> {
  return request(`${base}/${encodeURIComponent(issueId)}`);
}

// Logs at ERROR or above become error issues.
export const errorLogSeverityNumber = 17;

// The ID of the issue a log belongs to; null when it has none.
export async function fetchLogErrorIssueId(log: LogRecord): Promise<string | null> {
  const body = await request<{ issueId: string | null }>(`${base}/for-log`, {
    body: {
      attributes: log.log_attrs,
      body: log.body,
      exceptionMessage: log.exception_message,
      exceptionStacktrace: log.exception_stacktrace,
      exceptionType: log.exception_type,
      service: log.service,
      severity: log.severity,
      severityNumber: log.severity_number,
    },
    method: "POST",
  });
  return body.issueId;
}

export async function updateErrorIssueStatus(issueId: string, status: ErrorIssueStatus): Promise<ErrorIssue> {
  const body = await request<{ issue: ErrorIssue }>(`${base}/${encodeURIComponent(issueId)}`, {
    body: { status },
    method: "PATCH",
  });
  return body.issue;
}

export const errorIssueStatusLabels: Record<ErrorIssueStatus, string> = {
  open: "Unresolved",
  resolved: "Resolved",
  silenced: "Ignored",
};

const hourMs = 3_600_000;
const dayMs = 86_400_000;

// One count per UTC day from `since` for `length` days, with zero for days
// without occurrences.
export function dailyCounts(days: ErrorIssueDay[], since: string, length: number): number[] {
  const start = Date.parse(`${since}T00:00:00Z`);
  const counts = Array.from({ length }, () => 0);
  for (const day of days) {
    const index = Math.round((Date.parse(`${day.day}T00:00:00Z`) - start) / dayMs);
    if (index >= 0 && index < length) counts[index] = (counts[index] ?? 0) + day.eventCount;
  }
  return counts;
}

// One count per UTC hour from `since` for `length` hours, with zero for hours
// without occurrences.
export function hourlyCounts(hours: ErrorIssueHour[], since: string, length: number): number[] {
  const start = Date.parse(since);
  const counts = Array.from({ length }, () => 0);
  for (const hour of hours) {
    const index = Math.round((Date.parse(hour.hour) - start) / hourMs);
    if (index >= 0 && index < length) counts[index] = (counts[index] ?? 0) + hour.eventCount;
  }
  return counts;
}

// The days since `since`, through today.
export function daysThroughToday(since: string, now = Date.now()): number {
  return Math.max(1, Math.floor((now - Date.parse(`${since}T00:00:00Z`)) / dayMs) + 1);
}

export function errorIssueChart(days: ErrorIssueDay[], since: string, now = Date.now()): ChartData {
  const length = daysThroughToday(since, now);
  const start = Date.parse(`${since}T00:00:00Z`);
  return {
    buckets: Array.from({ length }, (_, index) => start + index * dayMs),
    series: [{ name: "Occurrences", other: false, values: dailyCounts(days, since, length) }],
    stepMs: dayMs,
  };
}

// "1.2k" past a thousand, so counts fit a narrow column.
export function formatEventCount(count: number): string {
  if (count < 1_000) return count.toLocaleString();
  if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0).replace(/\.0$/u, "")}k`;
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0).replace(/\.0$/u, "")}M`;
}

// The attributes of the newest occurrence, sorted for display.
export function sampleAttributes(attributes: Record<string, string>): Array<[string, string]> {
  return Object.entries(attributes).sort(([left], [right]) => left.localeCompare(right));
}

// The shortest explorer range that reaches an issue's last occurrence.
export function errorIssueRange(lastSeenAt: string, now = Date.now()): "24h" | "7d" | "30d" {
  const age = now - Date.parse(lastSeenAt);
  if (age < 23 * hourMs) return "24h";
  if (age < 7 * dayMs - hourMs) return "7d";
  return "30d";
}

export function errorActivity(lastSeenAt: string, now = Date.now()): "active" | "inactive" {
  return Date.parse(lastSeenAt) >= now - 15 * 60_000 ? "active" : "inactive";
}

export function errorState(issue: ErrorIssueSummary, now = Date.now()): string {
  if (issue.regressedAt) return "Regressed";
  return Date.parse(issue.firstSeenAt) >= now - 86_400_000 ? "New" : "Recurring";
}

// Old daily totals can outlive hourly retention. Never spread them across
// invented hours: keep daily resolution until all days have hourly coverage.
export function errorIssueDetailChart(detail: Pick<ErrorIssueDetail, "days" | "hours" | "since">, now = Date.now()): ChartData {
  const daily = errorIssueChart(detail.days, detail.since, now);
  if (!detail.hours) return daily;
  const start = Date.parse(`${detail.since}T00:00:00Z`);
  const length = Math.floor((now - start) / hourMs) + 1;
  const hours = hourlyCounts(detail.hours, new Date(start).toISOString(), length);
  const complete = daily.series[0]!.values.every((value, index) =>
    hours.slice(index * 24, (index + 1) * 24).reduce((sum, count) => sum + count, 0) === value);
  if (!complete) return daily;
  const values = Array.from({ length: Math.ceil(length / 3) }, (_, index) =>
    hours.slice(index * 3, index * 3 + 3).reduce((sum, count) => sum + count, 0));
  return {
    buckets: values.map((_, index) => start + index * 3 * hourMs),
    series: [{ name: "Occurrences", other: false, values }],
    stepMs: 3 * hourMs,
  };
}
