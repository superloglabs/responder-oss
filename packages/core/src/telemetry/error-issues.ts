import type { TelemetryClient } from "./client.js";
import {
  type Fingerprint,
  fingerprint,
  fingerprintLog,
  pythonTracebackException,
  stripNullBytes,
} from "./fingerprint.js";

// Error issues group a workspace's exceptions by fingerprint. Exceptions are
// span events named "exception" and logs at ERROR severity or above. The
// worker reads them from ClickHouse in arrival order and keeps one issue per
// fingerprint in Postgres.

export const errorIssueKinds = ["span", "log"] as const;
export type ErrorIssueKind = (typeof errorIssueKinds)[number];
export const errorIssueStatuses = ["open", "resolved", "silenced"] as const;
export type ErrorIssueStatus = (typeof errorIssueStatuses)[number];

// What an occurrence means for its issue:
// - new: the fingerprint had no issue
// - regressed: the issue was resolved before the occurrence, and is open again
// - seen: the issue keeps its status: it is open, or the occurrence is from
//   before it was resolved
// - silenced: the issue is silenced; only its counts change
export type ErrorIssueTransition = "new" | "regressed" | "seen" | "silenced";

// The newest occurrence of an issue, as shown on it.
export type ErrorIssueSample = {
  attributes: Record<string, string>;
  kind: ErrorIssueKind;
  message: string | null;
  resourceAttributes: Record<string, string>;
  seenAt: string;
  service: string | null;
  severity: string | null;
  spanId: string | null;
  spanName: string | null;
  stacktrace: string | null;
  traceId: string | null;
};

// One exception from the otel_issue_candidates projection.
export type ErrorCandidate = {
  attrs: Record<string, string>;
  body: string;
  candidate_id: string;
  // Milliseconds since the epoch. ClickHouse sends 64-bit integers as strings.
  discovered_ms: number | string;
  exception_message: string;
  exception_stacktrace: string;
  exception_type: string;
  kind: ErrorIssueKind;
  project_id: string;
  resource_attrs: Record<string, string>;
  seen_ms: number | string;
  service: string;
  severity: string;
  span_id: string;
  span_name: string;
  trace_id: string;
};

// The occurrences of one issue in a batch.
export type ErrorOccurrences = {
  // Occurrences per UTC day, as YYYY-MM-DD.
  dailyCounts: Record<string, number>;
  eventCount: number;
  exceptionType: string;
  fingerprint: string;
  firstSeenAt: Date;
  frames: string[];
  kind: ErrorIssueKind;
  lastSeenAt: Date;
  message: string | null;
  organizationId: string;
  sample: ErrorIssueSample;
  service: string | null;
  title: string;
  topFrame: string | null;
};

// Where the worker has read up to: the arrival time and ID of the last
// candidate it took.
export type ErrorCandidateCursor = { candidateId: string; discoveredAt: Date };

export const zeroCandidateId = "00000000-0000-0000-0000-000000000000";

// How far one pass reads past the cursor, and how long the worker waits
// before reading a candidate, so rows still being written or replicated are
// not skipped.
export const errorCandidateWindowMs = 5 * 60_000;
export const errorCandidateSettleMs = 30_000;

const maximumMessageLength = 4_000;
const maximumStacktraceLength = 16_000;
const maximumTitleLength = 200;

// The worker reads behind the present, so an occurrence can arrive after the
// issue was resolved and still be older than the resolution.
export function occurrenceTransition(
  previous: { status: ErrorIssueStatus; statusChangedAt: Date | null } | null,
  lastSeenAt: Date,
): ErrorIssueTransition {
  if (previous === null) return "new";
  if (previous.status === "resolved") {
    return previous.statusChangedAt && lastSeenAt <= previous.statusChangedAt ? "seen" : "regressed";
  }
  if (previous.status === "silenced") return "silenced";
  return "seen";
}

// The window one pass reads: from the cursor up to a few minutes past it,
// and never later than the settle time. A workspace's first pass starts at
// the settle time, since the projection has no history worth reading.
export function errorCandidateWindow(
  cursor: ErrorCandidateCursor | null,
  now: Date,
): { cursor: ErrorCandidateCursor; until: Date } {
  const settled = now.getTime() - errorCandidateSettleMs;
  if (!cursor) {
    const start = new Date(settled);
    return { cursor: { candidateId: zeroCandidateId, discoveredAt: start }, until: start };
  }
  const from = cursor.discoveredAt.getTime();
  return { cursor, until: new Date(Math.max(from, Math.min(from + errorCandidateWindowMs, settled))) };
}

// Where the next pass starts. A full batch stops at its last row; a partial
// one has read the whole window.
export function nextErrorCandidateCursor(
  window: { cursor: ErrorCandidateCursor; until: Date },
  rows: Pick<ErrorCandidate, "candidate_id" | "discovered_ms">[],
  limit: number,
): ErrorCandidateCursor {
  const last = rows.at(-1);
  if (last && rows.length >= limit) {
    return { candidateId: last.candidate_id, discoveredAt: new Date(Number(last.discovered_ms)) };
  }
  // At the same instant, keep the ID so the rows already read are not read again.
  if (window.until.getTime() === window.cursor.discoveredAt.getTime()) return window.cursor;
  return { candidateId: zeroCandidateId, discoveredAt: window.until };
}

export async function errorCandidates(
  client: TelemetryClient,
  input: {
    kind: ErrorIssueKind;
    limit: number;
    organizationIds: string[];
    window: { cursor: ErrorCandidateCursor; until: Date };
  },
): Promise<ErrorCandidate[]> {
  if (input.organizationIds.length === 0) return [];
  const result = await client.query({
    format: "JSONEachRow",
    query: `
      SELECT
        toUnixTimestamp64Milli(discovered_at) AS discovered_ms,
        candidate_id,
        toUnixTimestamp64Milli(Timestamp) AS seen_ms,
        kind, project_id, service, span_name, trace_id, span_id,
        exception_type, exception_message, exception_stacktrace,
        attrs, resource_attrs, body, severity
      FROM otel_issue_candidates
      WHERE kind = {kind:String}
        AND project_id IN {organizationIds:Array(String)}
        AND (discovered_at, candidate_id) > (fromUnixTimestamp64Milli({fromMs:Int64}, 'UTC'), toUUID({fromId:String}))
        AND discovered_at < fromUnixTimestamp64Milli({untilMs:Int64}, 'UTC')
      ORDER BY discovered_at, candidate_id
      LIMIT {limit:UInt32}
    `,
    query_params: {
      fromId: input.window.cursor.candidateId,
      fromMs: input.window.cursor.discoveredAt.getTime(),
      kind: input.kind,
      limit: input.limit,
      organizationIds: input.organizationIds,
      untilMs: input.window.until.getTime(),
    },
  });
  return result.json<ErrorCandidate>();
}

function truncate(value: string | null, length: number): string | null {
  return value && value.length > length ? value.slice(0, length) : value;
}

function cleanAttributes(attributes: Record<string, string> | null | undefined): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (key.startsWith("superlog.")) continue;
    clean[stripNullBytes(key)] = truncate(stripNullBytes(value), maximumMessageLength) ?? "";
  }
  return clean;
}

export function errorIssueTitle(fp: Pick<Fingerprint, "exceptionType" | "topFrame">, message: string | null): string {
  const firstLine = message?.split("\n").find((line) => line.trim())?.trim();
  const title = firstLine
    ? `${fp.exceptionType}: ${firstLine}`
    : fp.topFrame
      ? `${fp.exceptionType} in ${fp.topFrame}`
      : fp.exceptionType;
  return title.length > maximumTitleLength ? `${title.slice(0, maximumTitleLength - 1)}…` : title;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Fingerprints each candidate and collapses those with the same workspace and
// fingerprint, so an exception storm is one write per issue. The newest
// occurrence becomes the sample.
export function groupErrorCandidates(candidates: ErrorCandidate[]): ErrorOccurrences[] {
  const groups = new Map<string, ErrorOccurrences>();
  for (const candidate of candidates) {
    // A log whose body is a Python traceback has its stack there.
    const bodyTraceback = candidate.kind === "log" && !candidate.exception_stacktrace
      ? pythonTracebackException(candidate.body)
      : null;
    const stacktrace = stripNullBytes(bodyTraceback ? candidate.body : candidate.exception_stacktrace) || null;
    const service = stripNullBytes(candidate.service) || null;
    const severity = stripNullBytes(candidate.severity) || null;
    const fp = candidate.kind === "span"
      ? fingerprint({
        message: candidate.exception_message,
        stacktrace,
        type: candidate.exception_type,
      })
      : fingerprintLog({
        body: candidate.body,
        exceptionType: candidate.exception_type || null,
        message: candidate.exception_message || null,
        service: candidate.service,
        severity: candidate.severity,
        stacktrace: bodyTraceback ? null : stacktrace,
      });
    const message = stripNullBytes(
      candidate.kind === "span"
        ? candidate.exception_message
        : candidate.exception_message || (bodyTraceback ? bodyTraceback.message : candidate.body),
    ) || null;
    const seenAt = new Date(Number(candidate.seen_ms));
    const key = `${candidate.project_id}:${fp.hash}`;
    const sample: ErrorIssueSample = {
      attributes: cleanAttributes(candidate.attrs),
      kind: candidate.kind,
      message: truncate(message, maximumMessageLength),
      resourceAttributes: cleanAttributes(candidate.resource_attrs),
      seenAt: seenAt.toISOString(),
      service,
      severity,
      spanId: candidate.span_id || null,
      spanName: stripNullBytes(candidate.span_name) || null,
      stacktrace: truncate(stacktrace, maximumStacktraceLength),
      traceId: candidate.trace_id || null,
    };
    const day = utcDay(seenAt);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        dailyCounts: { [day]: 1 },
        eventCount: 1,
        exceptionType: fp.exceptionType,
        fingerprint: fp.hash,
        firstSeenAt: seenAt,
        frames: fp.normalizedFrames,
        kind: candidate.kind,
        lastSeenAt: seenAt,
        message: sample.message,
        organizationId: candidate.project_id,
        sample,
        service,
        title: errorIssueTitle(fp, message),
        topFrame: fp.topFrame,
      });
      continue;
    }
    existing.eventCount += 1;
    existing.dailyCounts[day] = (existing.dailyCounts[day] ?? 0) + 1;
    if (seenAt < existing.firstSeenAt) existing.firstSeenAt = seenAt;
    if (seenAt >= existing.lastSeenAt) {
      existing.lastSeenAt = seenAt;
      existing.message = sample.message;
      existing.sample = sample;
      existing.service = service ?? existing.service;
      existing.title = errorIssueTitle(fp, message);
    }
  }
  return [...groups.values()];
}
