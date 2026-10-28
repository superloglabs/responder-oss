import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, lt, or, type SQL, sql } from "drizzle-orm";
import {
  type ErrorCandidateCursor,
  type ErrorIssueKind,
  type ErrorIssueSample,
  type ErrorIssueStatus,
  type ErrorIssueTransition,
  type ErrorOccurrences,
  occurrenceTransition,
} from "../telemetry/error-issues.js";
import { enqueueErrorNotifications } from "./error-notifications.js";
import { getDatabase } from "./client.js";
import { pausedTelemetryNotificationOrganizations } from "./telemetry-notification-pauses.js";
import { errorIssueCursors, errorIssueDailyCounts, errorIssueHourlyCounts, errorIssues, organizationCapabilities } from "./schema.js";

type Database = ReturnType<typeof getDatabase>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Transaction;

// Keep the detail chart’s 30 UTC days, including its partial first day.
export const errorIssueHourlyRetentionMs = 31 * 86_400_000;

export type RecordedErrorOccurrences = {
  issueId: string;
  transition: ErrorIssueTransition;
};

// What a pass reads and writes, inside one transaction.
export type ErrorIssueStore = {
  cursor(kind: ErrorIssueKind): Promise<ErrorCandidateCursor | null>;
  organizationIds(): Promise<string[]>;
  pausedOrganizationIds(): Promise<Set<string>>;
  record(occurrences: ErrorOccurrences): Promise<RecordedErrorOccurrences>;
  saveCursor(kind: ErrorIssueKind, cursor: ErrorCandidateCursor): Promise<void>;
};

// Runs a pass in a transaction that holds the cell's error issue lock, so two
// workers, as during a deploy, do not count the same occurrences twice. Returns
// null without running when another worker holds it.
export async function withErrorIssueStore<T>(pass: (store: ErrorIssueStore) => Promise<T>): Promise<T | null> {
  return getDatabase().transaction(async (tx) => {
    const lock = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtextextended('error-issue-ingest', 0)) as locked`,
    );
    if (!lock.rows[0]?.locked) return null;
    return pass({
      cursor: (kind) => errorIssueCursor(tx, kind),
      organizationIds: () => telemetryOrganizationIds(tx),
      pausedOrganizationIds: () => pausedTelemetryNotificationOrganizations(tx),
      // A savepoint per issue, so one failed write does not undo the others.
      record: (occurrences) => tx.transaction((savepoint) => recordErrorOccurrences(savepoint, occurrences)),
      saveCursor: (kind, cursor) => saveErrorIssueCursor(tx, kind, cursor),
    });
  });
}

// Workspaces whose telemetry is grouped into issues.
async function telemetryOrganizationIds(executor: Executor): Promise<string[]> {
  const rows = await executor
    .select({ organizationId: organizationCapabilities.organizationId })
    .from(organizationCapabilities)
    .where(and(eq(organizationCapabilities.capability, "telemetry"), eq(organizationCapabilities.enabled, true)));
  return rows.map((row) => row.organizationId);
}

async function errorIssueCursor(executor: Executor, kind: ErrorIssueKind): Promise<ErrorCandidateCursor | null> {
  const [row] = await executor
    .select({ candidateId: errorIssueCursors.candidateId, discoveredAt: errorIssueCursors.discoveredAt })
    .from(errorIssueCursors)
    .where(eq(errorIssueCursors.kind, kind));
  return row ?? null;
}

async function saveErrorIssueCursor(executor: Executor, kind: ErrorIssueKind, cursor: ErrorCandidateCursor) {
  await executor
    .insert(errorIssueCursors)
    .values({ candidateId: cursor.candidateId, discoveredAt: cursor.discoveredAt, kind })
    .onConflictDoUpdate({
      set: { candidateId: cursor.candidateId, discoveredAt: cursor.discoveredAt, updatedAt: new Date() },
      target: errorIssueCursors.kind,
    });
}

// Adds a batch's occurrences to their issue, creating it for a new
// fingerprint. A resolved issue opens again. The issue row is locked first,
// so a status change made at the same time is not lost.
export async function recordErrorOccurrences(
  executor: Executor,
  occurrences: ErrorOccurrences,
): Promise<RecordedErrorOccurrences> {
  const issueColumns = { id: errorIssues.id, status: errorIssues.status, statusChangedAt: errorIssues.statusChangedAt };
  let [existing] = await executor
    .select(issueColumns)
    .from(errorIssues)
    .where(and(eq(errorIssues.organizationId, occurrences.organizationId), eq(errorIssues.fingerprint, occurrences.fingerprint)))
    .for("update");
  // An issue keyed by the previous algorithm moves to the current
  // fingerprint, so a known error is not opened again as new. When several
  // previous issues now share a fingerprint, the most recently seen moves.
  let previousFingerprint = false;
  if (!existing && occurrences.previousFingerprints.length > 0) {
    [existing] = await executor
      .select(issueColumns)
      .from(errorIssues)
      .where(and(
        eq(errorIssues.organizationId, occurrences.organizationId),
        inArray(errorIssues.fingerprint, occurrences.previousFingerprints),
      ))
      .orderBy(desc(errorIssues.lastSeenAt))
      .limit(1)
      .for("update");
    previousFingerprint = Boolean(existing);
  }
  const transition = occurrenceTransition(existing ?? null, occurrences.lastSeenAt);
  const now = new Date();
  let issueId: string;
  if (!existing) {
    const [created] = await executor
      .insert(errorIssues)
      .values({
        eventCount: occurrences.eventCount,
        exceptionType: occurrences.exceptionType,
        fingerprint: occurrences.fingerprint,
        firstSeenAt: occurrences.firstSeenAt,
        frames: occurrences.frames,
        kind: occurrences.kind,
        lastSample: occurrences.sample,
        lastSeenAt: occurrences.lastSeenAt,
        message: occurrences.message,
        organizationId: occurrences.organizationId,
        service: occurrences.service,
        title: occurrences.title,
        topFrame: occurrences.topFrame,
      })
      .returning({ id: errorIssues.id });
    issueId = created!.id;
  } else {
    // A batch can hold an occurrence older than the issue's newest; the sample
    // and title follow the newest.
    const newer = sql`${occurrences.lastSeenAt.toISOString()}::timestamptz >= ${errorIssues.lastSeenAt}`;
    await executor
      .update(errorIssues)
      .set({
        eventCount: sql`${errorIssues.eventCount} + ${occurrences.eventCount}`,
        ...(previousFingerprint ? { fingerprint: occurrences.fingerprint } : {}),
        firstSeenAt: sql`least(${errorIssues.firstSeenAt}, ${occurrences.firstSeenAt.toISOString()}::timestamptz)`,
        frames: sql`case when ${newer} then ${JSON.stringify(occurrences.frames)}::jsonb else ${errorIssues.frames} end`,
        lastSample: sql`case when ${newer} then ${JSON.stringify(occurrences.sample)}::jsonb else ${errorIssues.lastSample} end`,
        lastSeenAt: sql`greatest(${errorIssues.lastSeenAt}, ${occurrences.lastSeenAt.toISOString()}::timestamptz)`,
        message: sql`case when ${newer} then ${occurrences.message} else ${errorIssues.message} end`,
        service: sql`case when ${newer} then coalesce(${occurrences.service}, ${errorIssues.service}) else ${errorIssues.service} end`,
        title: sql`case when ${newer} then ${occurrences.title} else ${errorIssues.title} end`,
        updatedAt: now,
        ...(transition === "regressed" ? { regressedAt: now, status: "open" as const, statusChangedAt: now } : {}),
      })
      .where(eq(errorIssues.id, existing.id));
    issueId = existing.id;
  }
  const days = Object.entries(occurrences.dailyCounts);
  if (days.length > 0) {
    await executor
      .insert(errorIssueDailyCounts)
      .values(days.map(([day, eventCount]) => ({ day, eventCount, issueId })))
      .onConflictDoUpdate({
        set: { eventCount: sql`${errorIssueDailyCounts.eventCount} + excluded.event_count` },
        target: [errorIssueDailyCounts.issueId, errorIssueDailyCounts.day],
      });
  }
  const oldest = new Date(now.getTime() - errorIssueHourlyRetentionMs);
  const hours = Object.entries(occurrences.hourlyCounts).filter(([hour]) => Date.parse(hour) >= oldest.getTime());
  if (hours.length > 0) {
    await executor
      .insert(errorIssueHourlyCounts)
      .values(hours.map(([hour, eventCount]) => ({ eventCount, hour: new Date(hour), issueId })))
      .onConflictDoUpdate({
        set: { eventCount: sql`${errorIssueHourlyCounts.eventCount} + excluded.event_count` },
        target: [errorIssueHourlyCounts.issueId, errorIssueHourlyCounts.hour],
      });
  }
  await executor
    .delete(errorIssueHourlyCounts)
    .where(and(eq(errorIssueHourlyCounts.issueId, issueId), lt(errorIssueHourlyCounts.hour, oldest)));
  if (transition === "new" || transition === "regressed") {
    await enqueueErrorNotifications(executor, {
      organizationId: occurrences.organizationId,
      issueId,
      eventKey: transition === "new" ? "new" : `regressed:${now.toISOString()}`,
      snapshot: { title: occurrences.title, service: occurrences.service, exceptionType: occurrences.exceptionType,
        seenAt: occurrences.lastSeenAt.toISOString(), transition },
    });
  }
  return { issueId, transition };
}

export type ErrorIssueSummary = {
  eventCount: number;
  exceptionType: string;
  firstSeenAt: string;
  id: string;
  kind: ErrorIssueKind;
  lastSeenAt: string;
  regressedAt: string | null;
  service: string | null;
  status: ErrorIssueStatus;
  statusChangedAt: string | null;
  title: string;
  topFrame: string | null;
};

export type ErrorIssue = ErrorIssueSummary & {
  fingerprint: string;
  frames: string[];
  lastSample: ErrorIssueSample;
  message: string | null;
};

export type ErrorIssueDay = { day: string; eventCount: number };

// An hour is the ISO time it starts.
export type ErrorIssueHour = { eventCount: number; hour: string };

export type ErrorIssueListFilter = {
  // The last issue of the previous page, by last seen time then ID.
  before?: { id: string; lastSeenAt: string; firstSeenAt?: string; eventCount?: number };
  sort?: "lastSeen" | "firstSeen" | "events";
  limit: number;
  statuses?: ErrorIssueStatus[];
  services?: string[];
  environments?: string[];
  activeSince?: string;
  activity?: "active" | "inactive";
  since?: string;
  search?: string;
  service?: string;
  status?: ErrorIssueStatus;
};

const summaryColumns = {
  eventCount: errorIssues.eventCount,
  exceptionType: errorIssues.exceptionType,
  firstSeenAt: errorIssues.firstSeenAt,
  id: errorIssues.id,
  kind: errorIssues.kind,
  lastSeenAt: errorIssues.lastSeenAt,
  regressedAt: errorIssues.regressedAt,
  service: errorIssues.service,
  status: errorIssues.status,
  statusChangedAt: errorIssues.statusChangedAt,
  title: errorIssues.title,
  topFrame: errorIssues.topFrame,
};

type SummaryRow = Omit<ErrorIssueSummary, "firstSeenAt" | "lastSeenAt" | "regressedAt" | "statusChangedAt"> & {
  firstSeenAt: Date;
  lastSeenAt: Date;
  regressedAt: Date | null;
  statusChangedAt: Date | null;
};

function toSummary(row: SummaryRow): ErrorIssueSummary {
  return {
    ...row,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    regressedAt: row.regressedAt?.toISOString() ?? null,
    statusChangedAt: row.statusChangedAt?.toISOString() ?? null,
  };
}

// The text a search matches as written, with LIKE's wildcards escaped.
function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`;
}

// Environment follows the latest occurrence, matching the issue's service and sample.
const errorEnvironment = sql<string>`coalesce(nullif(${errorIssues.lastSample}->'resourceAttributes'->>'deployment.environment.name', ''), nullif(${errorIssues.lastSample}->'resourceAttributes'->>'deployment.environment', ''), nullif(${errorIssues.lastSample}->'attributes'->>'deployment.environment.name', ''), nullif(${errorIssues.lastSample}->'attributes'->>'deployment.environment', ''))`;

export async function errorIssueEnvironments(organizationId: string): Promise<string[]> {
  const rows = await getDatabase().selectDistinct({ environment: errorEnvironment }).from(errorIssues)
    .where(eq(errorIssues.organizationId, organizationId)).orderBy(asc(errorEnvironment));
  return rows.flatMap(({ environment }) => environment ? [environment] : []);
}

// A workspace's issues, most recently seen first.
export async function listErrorIssues(
  organizationId: string,
  filter: ErrorIssueListFilter,
): Promise<ErrorIssueSummary[]> {
  const conditions: SQL[] = [eq(errorIssues.organizationId, organizationId)];
  if (filter.status) conditions.push(eq(errorIssues.status, filter.status));
  if (filter.service) conditions.push(eq(errorIssues.service, filter.service));
  if (filter.statuses?.length) conditions.push(inArray(errorIssues.status, filter.statuses));
  if (filter.services?.length) conditions.push(inArray(errorIssues.service, filter.services));
  if (filter.environments?.length) conditions.push(inArray(errorEnvironment, filter.environments));
  if (filter.since) conditions.push(gte(errorIssues.lastSeenAt, new Date(filter.since)));
  if (filter.activeSince && filter.activity) {
    conditions.push(filter.activity === "active"
      ? gte(errorIssues.lastSeenAt, new Date(filter.activeSince))
      : lt(errorIssues.lastSeenAt, new Date(filter.activeSince)));
  }
  if (filter.search) {
    const pattern = likePattern(filter.search);
    conditions.push(or(ilike(errorIssues.title, pattern), ilike(errorIssues.topFrame, pattern), ilike(errorIssues.exceptionType, pattern), ilike(errorIssues.message, pattern), ilike(errorIssues.service, pattern), ilike(sql`${errorIssues.id}::text`, pattern))!);
  }
  const order = filter.sort === "events" ? errorIssues.eventCount : filter.sort === "firstSeen" ? errorIssues.firstSeenAt : errorIssues.lastSeenAt;
  if (filter.before) {
    const value = filter.sort === "events" ? filter.before.eventCount! : new Date(filter.sort === "firstSeen" ? filter.before.firstSeenAt! : filter.before.lastSeenAt);
    conditions.push(or(lt(order, value), and(eq(order, value), lt(errorIssues.id, filter.before.id)))!);
  }
  const rows = await getDatabase()
    .select(summaryColumns)
    .from(errorIssues)
    .where(and(...conditions))
    .orderBy(desc(order), desc(errorIssues.id))
    .limit(filter.limit);
  return rows.map(toSummary);
}

// How many of a workspace's issues have each status.
export async function errorIssueStatusCounts(organizationId: string): Promise<Record<ErrorIssueStatus, number>> {
  const rows = await getDatabase()
    .select({ count: count(), status: errorIssues.status })
    .from(errorIssues)
    .where(eq(errorIssues.organizationId, organizationId))
    .groupBy(errorIssues.status);
  const counts: Record<ErrorIssueStatus, number> = { open: 0, resolved: 0, silenced: 0 };
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

// The services a workspace's issues came from.
export async function errorIssueServices(organizationId: string): Promise<string[]> {
  const rows = await getDatabase()
    .selectDistinct({ service: errorIssues.service })
    .from(errorIssues)
    .where(and(eq(errorIssues.organizationId, organizationId), isNotNull(errorIssues.service)))
    .orderBy(asc(errorIssues.service));
  return rows.flatMap((row) => (row.service ? [row.service] : []));
}

export async function findErrorIssue(organizationId: string, issueId: string): Promise<ErrorIssue | null> {
  const [row] = await getDatabase()
    .select({
      ...summaryColumns,
      fingerprint: errorIssues.fingerprint,
      frames: errorIssues.frames,
      lastSample: errorIssues.lastSample,
      message: errorIssues.message,
    })
    .from(errorIssues)
    .where(and(eq(errorIssues.organizationId, organizationId), eq(errorIssues.id, issueId)));
  if (!row) return null;
  const { fingerprint, frames, lastSample, message, ...summary } = row;
  return { ...toSummary(summary), fingerprint, frames, lastSample, message };
}

// The issue with a fingerprint. An issue that has not moved to the current
// algorithm yet matches one of its previous fingerprints.
export async function findErrorIssueIdByFingerprint(
  organizationId: string,
  fingerprint: string,
  previousFingerprints: string[],
): Promise<string | null> {
  const [row] = await getDatabase()
    .select({ id: errorIssues.id })
    .from(errorIssues)
    .where(and(
      eq(errorIssues.organizationId, organizationId),
      inArray(errorIssues.fingerprint, [fingerprint, ...previousFingerprints]),
    ))
    .orderBy(desc(sql`${errorIssues.fingerprint} = ${fingerprint}`), desc(errorIssues.lastSeenAt))
    .limit(1);
  return row?.id ?? null;
}

// Occurrences per UTC day since a day, for each issue. Days without
// occurrences are left out.
export async function errorIssueDays(issueIds: string[], since: string): Promise<Map<string, ErrorIssueDay[]>> {
  const days = new Map<string, ErrorIssueDay[]>();
  if (issueIds.length === 0) return days;
  const rows = await getDatabase()
    .select({ day: errorIssueDailyCounts.day, eventCount: errorIssueDailyCounts.eventCount, issueId: errorIssueDailyCounts.issueId })
    .from(errorIssueDailyCounts)
    .where(and(inArray(errorIssueDailyCounts.issueId, issueIds), gte(errorIssueDailyCounts.day, since)))
    .orderBy(asc(errorIssueDailyCounts.day));
  for (const row of rows) {
    const list = days.get(row.issueId) ?? [];
    list.push({ day: row.day, eventCount: row.eventCount });
    days.set(row.issueId, list);
  }
  return days;
}

// Occurrences per UTC hour since an hour, for each issue. Hours without
// occurrences are left out.
export async function errorIssueHours(issueIds: string[], since: string): Promise<Map<string, ErrorIssueHour[]>> {
  const hours = new Map<string, ErrorIssueHour[]>();
  if (issueIds.length === 0) return hours;
  const rows = await getDatabase()
    .select({ eventCount: errorIssueHourlyCounts.eventCount, hour: errorIssueHourlyCounts.hour, issueId: errorIssueHourlyCounts.issueId })
    .from(errorIssueHourlyCounts)
    .where(and(inArray(errorIssueHourlyCounts.issueId, issueIds), gte(errorIssueHourlyCounts.hour, new Date(since))))
    .orderBy(asc(errorIssueHourlyCounts.hour));
  for (const row of rows) {
    const list = hours.get(row.issueId) ?? [];
    list.push({ eventCount: row.eventCount, hour: row.hour.toISOString() });
    hours.set(row.issueId, list);
  }
  return hours;
}

// Resolves, silences, or reopens an issue. Returns null when the workspace
// has no such issue. Setting the status it already has keeps the time it was
// set, since the worker compares late occurrences with that time.
export async function setErrorIssueStatus(
  organizationId: string,
  issueId: string,
  status: ErrorIssueStatus,
): Promise<ErrorIssue | null> {
  const now = new Date();
  const updated = await getDatabase()
    .update(errorIssues)
    .set({
      status,
      statusChangedAt: sql`case when ${errorIssues.status} = ${status} then ${errorIssues.statusChangedAt} else ${now.toISOString()}::timestamptz end`,
      updatedAt: now,
    })
    .where(and(eq(errorIssues.organizationId, organizationId), eq(errorIssues.id, issueId)))
    .returning({ id: errorIssues.id });
  return updated.length > 0 ? findErrorIssue(organizationId, issueId) : null;
}
