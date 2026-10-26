import { and, asc, count, desc, eq, gte, ilike, inArray, or, sql } from "drizzle-orm";
import { getDatabase } from "./client.js";
import type { IssueEmbedding } from "./issues.js";
import {
  automationIssueRuns,
  automationIssues,
  automationRuns,
  severity,
  type AutomationIssueLink,
  type AutomationIssueSlackMessage,
} from "./schema.js";

const issueColumns = {
  firstSeenAt: automationIssues.firstSeenAt,
  id: automationIssues.id,
  lastSeenAt: automationIssues.lastSeenAt,
  links: automationIssues.links,
  occurrences: automationIssues.occurrences,
  severity: automationIssues.severity,
  slackMessages: automationIssues.slackMessages,
  summary: automationIssues.summary,
  title: automationIssues.title,
};

export interface AutomationIssue {
  firstSeenAt: Date;
  id: string;
  lastSeenAt: Date;
  links: AutomationIssueLink[];
  occurrences: number;
  severity: AutomationIssueSeverity | null;
  slackMessages: AutomationIssueSlackMessage[];
  summary: string;
  title: string;
}

export type AutomationIssueSeverity = (typeof severity.enumValues)[number];

export class AutomationIssueRunLinkedError extends Error {
  constructor(readonly issueId: string) {
    super("This run is already linked to another issue");
    this.name = "AutomationIssueRunLinkedError";
  }
}

interface RunScope {
  automationId: string;
  organizationId: string;
  runId: string;
}

type Transaction = Parameters<Parameters<ReturnType<typeof getDatabase>["transaction"]>[0]>[0];

// Locks the run, so two calls from the same run take turns, and returns the
// issue it already filed or was attached to.
async function lockRun(tx: Transaction, scope: RunScope) {
  const [run] = await tx
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(and(
      eq(automationRuns.id, scope.runId),
      eq(automationRuns.automationId, scope.automationId),
      eq(automationRuns.organizationId, scope.organizationId),
    ))
    .for("update");
  if (!run) throw new Error("Automation run not found");
  const [link] = await tx
    .select({ issueId: automationIssueRuns.issueId, relationship: automationIssueRuns.relationship })
    .from(automationIssueRuns)
    .where(eq(automationIssueRuns.runId, scope.runId));
  return link ?? null;
}

async function issueById(tx: Transaction, scope: RunScope, issueId: string) {
  const [issue] = await tx
    .select(issueColumns)
    .from(automationIssues)
    .where(and(
      eq(automationIssues.id, issueId),
      eq(automationIssues.automationId, scope.automationId),
      eq(automationIssues.organizationId, scope.organizationId),
    ));
  return issue ?? null;
}

// Files a new issue for the run. A run files at most one issue: calling again
// returns the issue it already filed. The later runs of the automation that
// repeated the alert are attached to it, each counted once, so a later run
// that attaches itself again is not counted twice.
export async function fileAutomationIssue(input: RunScope & {
  embedding: IssueEmbedding | null;
  laterRunIds: string[];
  links: AutomationIssueLink[];
  severity: AutomationIssueSeverity;
  summary: string;
  title: string;
}): Promise<{
  issue: AutomationIssue;
  // An earlier run may have filed the issue and attached this run to it.
  status: "already_filed" | "attached_by_earlier_run" | "filed";
}> {
  return getDatabase().transaction(async (tx) => {
    const link = await lockRun(tx, input);
    if (link) {
      const issue = await issueById(tx, input, link.issueId);
      if (!issue) throw new Error("Automation issue not found");
      return { issue, status: link.relationship === "filed" ? "already_filed" : "attached_by_earlier_run" };
    }
    const [filed] = await tx
      .insert(automationIssues)
      .values({
        automationId: input.automationId,
        embedding: input.embedding?.vector ?? null,
        embeddingModel: input.embedding?.model ?? null,
        links: input.links,
        organizationId: input.organizationId,
        severity: input.severity,
        summary: input.summary,
        title: input.title,
      })
      .returning({ id: automationIssues.id });
    await tx.insert(automationIssueRuns).values({
      issueId: filed!.id,
      relationship: "filed",
      runId: input.runId,
    });
    const laterRunIds = [...new Set(input.laterRunIds)].filter((id) => id !== input.runId);
    const attached = laterRunIds.length === 0
      ? []
      : await tx
          .insert(automationIssueRuns)
          // In the table's column order, which an insert from a select needs.
          .select(tx
            .select({
              runId: automationRuns.id,
              issueId: sql<string>`${filed!.id}::uuid`.as("issue_id"),
              relationship: sql<"attached">`'attached'`.as("relationship"),
              createdAt: sql<Date>`now()`.as("created_at"),
            })
            .from(automationRuns)
            .where(and(
              inArray(automationRuns.id, laterRunIds),
              eq(automationRuns.automationId, input.automationId),
              eq(automationRuns.organizationId, input.organizationId),
            )))
          .onConflictDoNothing({ target: automationIssueRuns.runId })
          .returning({ runId: automationIssueRuns.runId });
    const [issue] = await tx
      .update(automationIssues)
      .set({ occurrences: 1 + attached.length })
      .where(eq(automationIssues.id, filed!.id))
      .returning(issueColumns);
    return { issue: issue!, status: "filed" };
  });
}

// Counts the run as another occurrence of an existing issue. Calling again
// for the same issue counts it once.
export async function attachAutomationIssue(input: RunScope & {
  issueId: string;
}): Promise<{ attached: boolean; issue: AutomationIssue } | null> {
  return getDatabase().transaction(async (tx) => {
    const link = await lockRun(tx, input);
    if (link && link.issueId !== input.issueId) {
      throw new AutomationIssueRunLinkedError(link.issueId);
    }
    if (link) {
      const issue = await issueById(tx, input, link.issueId);
      return issue ? { attached: false, issue } : null;
    }
    const [issue] = await tx
      .update(automationIssues)
      .set({
        lastSeenAt: sql`now()`,
        occurrences: sql`${automationIssues.occurrences} + 1`,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(automationIssues.id, input.issueId),
        eq(automationIssues.automationId, input.automationId),
        eq(automationIssues.organizationId, input.organizationId),
      ))
      .returning(issueColumns);
    if (!issue) return null;
    await tx.insert(automationIssueRuns).values({
      issueId: issue.id,
      relationship: "attached",
      runId: input.runId,
    });
    return { attached: true, issue };
  });
}

// Adds links and Slack posts made by a run to the issue it filed or attached
// to.
export async function appendAutomationIssueRecords(input: {
  issueId: string;
  links?: AutomationIssueLink[];
  slackMessages?: AutomationIssueSlackMessage[];
}): Promise<void> {
  const links = input.links ?? [];
  const slackMessages = input.slackMessages ?? [];
  if (links.length === 0 && slackMessages.length === 0) return;
  await getDatabase()
    .update(automationIssues)
    .set({
      links: sql`${automationIssues.links} || ${JSON.stringify(links)}::jsonb`,
      slackMessages: sql`${automationIssues.slackMessages} || ${JSON.stringify(slackMessages)}::jsonb`,
      updatedAt: sql`now()`,
    })
    .where(eq(automationIssues.id, input.issueId));
}

// The automation's most recently seen issues, with their embeddings.
export async function listAutomationIssueCandidates(input: {
  automationId: string;
  limit?: number;
  organizationId: string;
}) {
  return getDatabase()
    .select({
      ...issueColumns,
      embedding: automationIssues.embedding,
      embeddingModel: automationIssues.embeddingModel,
    })
    .from(automationIssues)
    .where(and(
      eq(automationIssues.automationId, input.automationId),
      eq(automationIssues.organizationId, input.organizationId),
    ))
    .orderBy(desc(automationIssues.lastSeenAt))
    .limit(input.limit ?? 1_000);
}

function likePattern(value: string): string {
  return `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

export async function searchAutomationIssuesByText(input: {
  automationId: string;
  limit: number;
  organizationId: string;
  query: string;
}): Promise<AutomationIssue[]> {
  const pattern = likePattern(input.query);
  return getDatabase()
    .select(issueColumns)
    .from(automationIssues)
    .where(and(
      eq(automationIssues.automationId, input.automationId),
      eq(automationIssues.organizationId, input.organizationId),
      or(ilike(automationIssues.title, pattern), ilike(automationIssues.summary, pattern)),
    ))
    .orderBy(desc(automationIssues.lastSeenAt))
    .limit(input.limit);
}

// The automation's runs that are still going or finished since the given
// time, oldest first, with the issue each filed or attached to. A title filter
// narrows them during an alert storm; the current run is returned on its own
// so it is never cut off by the limit.
export async function listRecentAutomationRuns(input: {
  automationId: string;
  currentRunId: string;
  finishedSince: Date;
  limit: number;
  organizationId: string;
  titleContains: string | null;
}) {
  const title = sql<string | null>`${automationRuns.triggerInput}->>'title'`;
  const recent = and(
    eq(automationRuns.automationId, input.automationId),
    eq(automationRuns.organizationId, input.organizationId),
    or(
      inArray(automationRuns.status, ["pending", "running"]),
      gte(automationRuns.completedAt, input.finishedSince),
    ),
    input.titleContains ? ilike(title, likePattern(input.titleContains)) : undefined,
  );
  const columns = {
    completedAt: automationRuns.completedAt,
    createdAt: automationRuns.createdAt,
    id: automationRuns.id,
    issueId: automationIssueRuns.issueId,
    relationship: automationIssueRuns.relationship,
    startedAt: automationRuns.startedAt,
    status: automationRuns.status,
    title,
  };
  const [runs, [total], [current]] = await Promise.all([
    getDatabase()
      .select(columns)
      .from(automationRuns)
      .leftJoin(automationIssueRuns, eq(automationIssueRuns.runId, automationRuns.id))
      .where(recent)
      .orderBy(asc(automationRuns.createdAt), asc(automationRuns.id))
      .limit(input.limit),
    getDatabase().select({ value: count() }).from(automationRuns).where(recent),
    getDatabase()
      .select(columns)
      .from(automationRuns)
      .leftJoin(automationIssueRuns, eq(automationIssueRuns.runId, automationRuns.id))
      .where(and(
        eq(automationRuns.id, input.currentRunId),
        eq(automationRuns.automationId, input.automationId),
        eq(automationRuns.organizationId, input.organizationId),
      )),
  ]);
  return { current: current ?? null, runs, total: total?.value ?? runs.length };
}

// A page of the automation's issues, most recently seen first, each with the
// run that filed it.
export async function listAutomationIssues(input: {
  automationId: string;
  limit: number;
  offset: number;
  organizationId: string;
}) {
  const scope = and(
    eq(automationIssues.automationId, input.automationId),
    eq(automationIssues.organizationId, input.organizationId),
  );
  const [issues, [total]] = await Promise.all([
    getDatabase()
      .select({ ...issueColumns, filedRunId: automationIssueRuns.runId })
      .from(automationIssues)
      .leftJoin(automationIssueRuns, and(
        eq(automationIssueRuns.issueId, automationIssues.id),
        eq(automationIssueRuns.relationship, "filed"),
      ))
      .where(scope)
      .orderBy(desc(automationIssues.lastSeenAt), desc(automationIssues.id))
      .limit(input.limit)
      .offset(input.offset),
    getDatabase().select({ value: count() }).from(automationIssues).where(scope),
  ]);
  return { issues, total: total?.value ?? issues.length };
}
