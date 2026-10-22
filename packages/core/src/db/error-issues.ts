import { and, eq, sql } from "drizzle-orm";
import {
  type ErrorCandidateCursor,
  type ErrorIssueKind,
  type ErrorIssueStatus,
  type ErrorIssueTransition,
  type ErrorOccurrences,
  occurrenceTransition,
} from "../telemetry/error-issues.js";
import { getDatabase } from "./client.js";
import { errorIssueCursors, errorIssueDailyCounts, errorIssues, organizationCapabilities } from "./schema.js";

type Database = ReturnType<typeof getDatabase>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Transaction;

export type RecordedErrorOccurrences = {
  issueId: string;
  transition: ErrorIssueTransition;
};

// What a pass reads and writes, inside one transaction.
export type ErrorIssueStore = {
  cursor(kind: ErrorIssueKind): Promise<ErrorCandidateCursor | null>;
  organizationIds(): Promise<string[]>;
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
  const [existing] = await executor
    .select({ id: errorIssues.id, status: errorIssues.status })
    .from(errorIssues)
    .where(and(eq(errorIssues.organizationId, occurrences.organizationId), eq(errorIssues.fingerprint, occurrences.fingerprint)))
    .for("update");
  const transition = occurrenceTransition((existing?.status as ErrorIssueStatus | undefined) ?? null);
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
        firstSeenAt: sql`least(${errorIssues.firstSeenAt}, ${occurrences.firstSeenAt.toISOString()}::timestamptz)`,
        frames: sql`case when ${newer} then ${JSON.stringify(occurrences.frames)}::jsonb else ${errorIssues.frames} end`,
        lastSample: sql`case when ${newer} then ${JSON.stringify(occurrences.sample)}::jsonb else ${errorIssues.lastSample} end`,
        lastSeenAt: sql`greatest(${errorIssues.lastSeenAt}, ${occurrences.lastSeenAt.toISOString()}::timestamptz)`,
        message: sql`case when ${newer} then ${occurrences.message} else ${errorIssues.message} end`,
        title: sql`case when ${newer} then ${occurrences.title} else ${errorIssues.title} end`,
        updatedAt: now,
        ...(occurrences.service ? { service: occurrences.service } : {}),
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
  return { issueId, transition };
}
