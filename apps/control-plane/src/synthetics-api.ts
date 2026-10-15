import { apiErrorMessage } from "./agents-api";
import type {
  SyntheticCheck,
  SyntheticCheckBucket,
  SyntheticCheckEpisode,
  SyntheticCheckRun,
  SyntheticCheckRunSummary,
  SyntheticCheckStats,
  SyntheticCheckSummary,
} from "../../../packages/core/src/db/synthetic-checks";
import type { TelemetryAlertSlackChannel } from "../../../packages/core/src/db/telemetry-alerts";
import type { SyntheticCheckInput, SyntheticTestInput } from "../../../packages/core/src/synthetics/schema";
import {
  syntheticAssertionOpsByKind,
  type SyntheticAssertion,
  type SyntheticAssertionKind,
  type SyntheticMethod,
  type SyntheticRunResult,
  type SyntheticRunStatus,
  type SyntheticTimings,
} from "../../../packages/core/src/synthetics/types";
import type { ChartData } from "./dashboards-api";

export type {
  SyntheticAssertion,
  SyntheticAssertionKind,
  SyntheticCheck,
  SyntheticCheckEpisode,
  SyntheticCheckRun,
  SyntheticCheckRunSummary,
  SyntheticCheckStats,
  SyntheticCheckSummary,
  SyntheticMethod,
  SyntheticRunResult,
  SyntheticRunStatus,
  SyntheticTimings,
};

const base = "/api/synthetic-checks";

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

// Null when the workspace cannot use synthetic checks.
export async function fetchSyntheticChecks(): Promise<SyntheticCheckSummary[] | null> {
  const response = await fetch(base);
  if (response.status === 404) return null;
  const body = (await response.json().catch(() => null)) as { checks: SyntheticCheckSummary[] } | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body?.checks ?? [];
}

export type SyntheticRange = "24h" | "7d" | "30d";

export interface SyntheticCheckDetail {
  bucketSeconds: number;
  check: SyntheticCheck;
  episodes: SyntheticCheckEpisode[];
  runs: SyntheticCheckRunSummary[];
  since: string;
  stats: SyntheticCheckStats;
}

export function fetchSyntheticCheck(checkId: string, range: SyntheticRange = "24h"): Promise<SyntheticCheckDetail> {
  return request(`${base}/${encodeURIComponent(checkId)}?${new URLSearchParams({ range })}`);
}

export async function fetchSyntheticCheckRuns(
  checkId: string,
  before: SyntheticCheckRunSummary,
): Promise<SyntheticCheckRunSummary[]> {
  const query = new URLSearchParams({ before: before.startedAt, beforeId: before.id });
  return (await request<{ runs: SyntheticCheckRunSummary[] }>(`${base}/${encodeURIComponent(checkId)}/runs?${query}`)).runs;
}

export async function fetchSyntheticCheckRun(checkId: string, runId: string): Promise<SyntheticCheckRun> {
  return (await request<{ run: SyntheticCheckRun }>(`${base}/${encodeURIComponent(checkId)}/runs/${encodeURIComponent(runId)}`)).run;
}

type CheckBody = Omit<SyntheticCheckInput, "headers"> & {
  headers: Array<{ name: string; secret: boolean; value: string | null }>;
};

export async function createSyntheticCheck(input: CheckBody): Promise<SyntheticCheck> {
  return (await request<{ check: SyntheticCheck }>(base, { body: input, method: "POST" })).check;
}

export async function updateSyntheticCheck(checkId: string, input: CheckBody): Promise<SyntheticCheck> {
  return (await request<{ check: SyntheticCheck }>(`${base}/${encodeURIComponent(checkId)}`, { body: input, method: "PUT" })).check;
}

export function deleteSyntheticCheck(checkId: string): Promise<void> {
  return request(`${base}/${encodeURIComponent(checkId)}`, { method: "DELETE" });
}

type TestBody = Omit<SyntheticTestInput, "headers"> & { headers: CheckBody["headers"] };

export async function testSyntheticCheck(input: TestBody): Promise<SyntheticRunResult> {
  return (await request<{ result: SyntheticRunResult }>(`${base}/test`, { body: input, method: "POST" })).result;
}

export async function fetchSyntheticSlackChannels(refresh = false): Promise<TelemetryAlertSlackChannel[]> {
  const body = await request<{ channels: TelemetryAlertSlackChannel[] }>(
    `${base}/slack-channels${refresh ? "/refresh" : ""}`,
    refresh ? { method: "POST" } : undefined,
  );
  return body.channels;
}

export interface SyntheticHeaderForm {
  name: string;
  // A secret with a saved value, which an empty value keeps.
  saved: boolean;
  secret: boolean;
  value: string;
}

export interface SyntheticAssertionForm {
  key: string;
  kind: SyntheticAssertionKind;
  op: SyntheticAssertion["op"];
  severity: SyntheticAssertion["severity"];
  value: string;
}

// The check editor's form. Numbers are kept as the menus' values.
export interface SyntheticForm {
  assertions: SyntheticAssertionForm[];
  body: string;
  enabled: boolean;
  failuresToAlert: number;
  followRedirects: boolean;
  headers: SyntheticHeaderForm[];
  intervalSeconds: number;
  method: SyntheticMethod;
  name: string;
  retries: number;
  // "integrationAccountId:channelId", or "" for no channel.
  slack: string;
  timeoutMs: number;
  url: string;
}

export function emptySyntheticForm(): SyntheticForm {
  return {
    assertions: [
      { key: "", kind: "status_code", op: "eq", severity: "critical", value: "2xx" },
      { key: "", kind: "response_time", op: "lt", severity: "degraded", value: "2000" },
    ],
    body: "",
    enabled: true,
    failuresToAlert: 1,
    followRedirects: true,
    headers: [],
    intervalSeconds: 300,
    method: "GET",
    name: "",
    retries: 1,
    slack: "",
    timeoutMs: 10_000,
    url: "",
  };
}

export function syntheticForm(check: SyntheticCheck): SyntheticForm {
  return {
    assertions: check.assertions.map((assertion) => ({ ...assertion, key: assertion.key ?? "" })),
    body: check.body ?? "",
    enabled: check.enabled,
    failuresToAlert: check.failuresToAlert,
    followRedirects: check.followRedirects,
    headers: check.headers.map((header) => ({ ...header, saved: header.secret })),
    intervalSeconds: check.intervalSeconds,
    method: check.method,
    name: check.name,
    retries: check.retries,
    slack: check.slack ? `${check.slack.integrationAccountId}:${check.slack.channelId}` : "",
    timeoutMs: check.timeoutMs,
    url: check.url,
  };
}

// A new assertion of a kind, with its first comparison and a typical value.
export function newSyntheticAssertion(kind: SyntheticAssertionKind): SyntheticAssertionForm {
  const value = { body: "", certificate_expiry: "14", header: "", json_path: "", response_time: "1000", status_code: "2xx" }[kind];
  return { key: "", kind, op: syntheticAssertionOpsByKind[kind][0]!, severity: "critical", value };
}

function requestFields(form: SyntheticForm) {
  const withoutBody = form.method === "GET" || form.method === "HEAD";
  return {
    assertions: form.assertions.map((assertion) => ({
      ...(assertion.kind === "header" || assertion.kind === "json_path" ? { key: assertion.key.trim() } : {}),
      kind: assertion.kind,
      op: assertion.op,
      severity: assertion.severity,
      value: assertion.op === "exists" || assertion.op === "not_exists" ? "" : assertion.value.trim(),
    })),
    body: withoutBody || !form.body ? null : form.body,
    followRedirects: form.followRedirects,
    headers: form.headers
      .filter((header) => header.name.trim() || header.value)
      .map((header) => ({
        name: header.name.trim(),
        secret: header.secret,
        value: header.secret && header.saved && !header.value ? null : header.value,
      })),
    method: form.method,
    timeoutMs: form.timeoutMs,
    url: form.url.trim(),
  };
}

// The check a form describes, or what to fix first.
export function syntheticRequestBody(form: SyntheticForm): { body: CheckBody } | { error: string } {
  if (!form.name.trim()) return { error: "Name the check." };
  if (!form.url.trim()) return { error: "Enter the URL to request." };
  const [integrationAccountId, channelId] = form.slack ? form.slack.split(":") : [];
  return {
    body: {
      ...requestFields(form),
      enabled: form.enabled,
      failuresToAlert: form.failuresToAlert,
      intervalSeconds: form.intervalSeconds,
      name: form.name.trim(),
      retries: form.retries,
      slack: integrationAccountId && channelId ? { channelId, integrationAccountId } : null,
    },
  };
}

export function syntheticTestBody(form: SyntheticForm, checkId: string | null): { body: TestBody } | { error: string } {
  if (!form.url.trim()) return { error: "Enter the URL to request." };
  return { body: { ...requestFields(form), checkId } };
}

export const syntheticStatusLabels: Record<SyntheticRunStatus, string> = {
  degraded: "Degraded",
  failed: "Failed",
  passed: "Passed",
};

export const syntheticStatusTones: Record<SyntheticRunStatus, "danger" | "live" | "warning"> = {
  degraded: "warning",
  failed: "danger",
  passed: "live",
};

export function formatUptime(uptime: number | null): string {
  if (uptime === null) return "—";
  if (uptime === 1) return "100%";
  // Never round a failure up to 100%.
  return `${Math.min(99.99, Math.floor(uptime * 10_000) / 100)}%`;
}

export function intervalLabel(seconds: number): string {
  if (seconds === 60) return "Every minute";
  if (seconds < 3_600) return `Every ${seconds / 60} minutes`;
  return seconds === 3_600 ? "Every hour" : `Every ${seconds / 3_600} hours`;
}

// A span of time, such as "3 days 4 hours", for how long a check has been up.
export function spanLabel(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 60) return minutes <= 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}${hours % 24 ? ` ${hours % 24} hour${hours % 24 === 1 ? "" : "s"}` : ""}`;
}

export interface UptimeSegment {
  degraded: number;
  failed: number;
  passed: number;
  start: number;
  status: SyntheticRunStatus | "none";
}

// One segment per bucket from `since` to now, coloured by its worst run.
export function uptimeSegments(buckets: SyntheticCheckBucket[], since: string, bucketSeconds: number, now = Date.now()): UptimeSegment[] {
  const start = Date.parse(since);
  const step = bucketSeconds * 1_000;
  const byStart = new Map(buckets.map((bucket) => [Date.parse(bucket.bucket), bucket]));
  const segments: UptimeSegment[] = [];
  for (let time = start; time < now; time += step) {
    const bucket = byStart.get(time);
    const counts = { degraded: bucket?.degraded ?? 0, failed: bucket?.failed ?? 0, passed: bucket?.passed ?? 0 };
    segments.push({
      ...counts,
      start: time,
      status: counts.failed ? "failed" : counts.degraded ? "degraded" : counts.passed ? "passed" : "none",
    });
  }
  return segments;
}

const phases = [
  ["DNS", "dnsMs"],
  ["Connect", "connectMs"],
  ["TLS", "tlsMs"],
  ["First byte", "firstByteMs"],
  ["Download", "downloadMs"],
] as const satisfies ReadonlyArray<readonly [string, keyof SyntheticTimings]>;

export const syntheticPhases = phases;

// The average time of each phase per bucket, stacked, for runs that did not
// fail.
export function timingChart(segments: UptimeSegment[], buckets: SyntheticCheckBucket[], bucketSeconds: number): ChartData {
  const byStart = new Map(buckets.map((bucket) => [Date.parse(bucket.bucket), bucket]));
  return {
    buckets: segments.map((segment) => segment.start),
    series: phases.map(([name, field]) => ({
      name,
      other: false,
      values: segments.map((segment) => byStart.get(segment.start)?.averageMs?.[field] ?? null),
    })),
    stepMs: bucketSeconds * 1_000,
  };
}
