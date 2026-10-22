import { apiErrorMessage } from "./agents-api";
import type {
  ErrorIssue,
  ErrorIssueDay,
  ErrorIssueSummary,
} from "../../../packages/core/src/db/error-issues";
import type { ErrorIssueStatus } from "../../../packages/core/src/telemetry/error-issues";
import type { ChartData } from "./dashboards-api";

export type { ErrorIssue, ErrorIssueDay, ErrorIssueStatus, ErrorIssueSummary };

export type ErrorIssueListItem = ErrorIssueSummary & { days: ErrorIssueDay[] };

export interface ErrorIssueList {
  counts: Record<ErrorIssueStatus, number>;
  issues: ErrorIssueListItem[];
  services: string[];
  // The first day the issues' counts cover.
  since: string;
}

export interface ErrorIssueDetail {
  days: ErrorIssueDay[];
  issue: ErrorIssue;
  since: string;
}

export type ErrorIssueFilter = {
  before?: Pick<ErrorIssueSummary, "id" | "lastSeenAt">;
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
  if (filter.service) params.set("service", filter.service);
  if (filter.search?.trim()) params.set("search", filter.search.trim());
  if (filter.before) {
    params.set("before", filter.before.lastSeenAt);
    params.set("beforeId", filter.before.id);
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

export async function updateErrorIssueStatus(issueId: string, status: ErrorIssueStatus): Promise<ErrorIssue> {
  const body = await request<{ issue: ErrorIssue }>(`${base}/${encodeURIComponent(issueId)}`, {
    body: { status },
    method: "PATCH",
  });
  return body.issue;
}

export const errorIssueStatusLabels: Record<ErrorIssueStatus, string> = {
  open: "Open",
  resolved: "Resolved",
  silenced: "Silenced",
};

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
