import { and, asc, count, desc, eq, gte, ilike, inArray, or, sql } from "drizzle-orm";
import { getDatabase } from "./client.js";
import type { IssueEmbedding } from "./issues.js";
import {
  automationIssueRuns,
  automationIssues,
  automationRuns,
  type AutomationIssueLink,
  type AutomationIssueSlackMessage,
} from "./schema.js";

const issueColumns = {
  firstSeenAt: automationIssues.firstSeenAt,
  id: automationIssues.id,
  lastSeenAt: automationIssues.lastSeenAt,
  links: automationIssues.links,
  occurrences: automationIssues.occurrences,
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
  slackMessages: AutomationIssueSlackMessage[];
  summary: string;
  title: string;
}

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
// issue it already filed or attached to.
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
    .select({ issueId: automationIssueRuns.issueId })
    .from(automationIssueRuns)
    .where(eq(automationIssueRuns.runId, scope.runId));
  return link?.issueId ?? null;
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
// returns the issue it already filed.
export async function fileAutomationIssue(input: RunScope & {
  embedding: IssueEmbedding | null;
  links: AutomationIssueLink[];
  occurrences: number;
  summary: string;
  title: string;
}): Promise<{ created: boolean; issue: AutomationIssue }> {
  return getDatabase().transaction(async (tx) => {
    const linkedIssueId = await lockRun(tx, input);
    if (linkedIssueId) {
      const issue = await issueById(tx, input, linkedIssueId);
      if (!issue) throw new Error("Automation issue not found");
      return { created: false, issue };
    }
    const [issue] = await tx
      .insert(automationIssues)
      .values({
        automationId: input.automationId,
        embedding: input.embedding?.vector ?? null,
        embeddingModel: input.embedding?.model ?? null,
        links: input.links,
        occurrences: input.occurrences,
        organizationId: input.organizationId,
        summary: input.summary,
        title: input.title,
      })
      .returning(issueColumns);
    await tx.insert(automationIssueRuns).values({
      issueId: issue!.id,
      relationship: "filed",
      runId: input.runId,
    });
    return { created: true, issue: issue! };
  });
}

// Counts the run as another occurrence of an existing issue. Calling again
// for the same issue counts it once.
export async function attachAutomationIssue(input: RunScope & {
  issueId: string;
}): Promise<{ attached: boolean; issue: AutomationIssue } | null> {
  return getDatabase().transaction(async (tx) => {
    const linkedIssueId = await lockRun(tx, input);
    if (linkedIssueId && linkedIssueId !== input.issueId) {
      throw new AutomationIssueRunLinkedError(linkedIssueId);
    }
    if (linkedIssueId) {
      const issue = await issueById(tx, input, linkedIssueId);
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

export async function searchAutomationIssuesByText(input: {
  automationId: string;
  limit: number;
  organizationId: string;
  query: string;
}): Promise<AutomationIssue[]> {
  const pattern = `%${input.query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
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
// time, oldest first, with the issue each filed or attached to.
export async function listRecentAutomationRuns(input: {
  automationId: string;
  finishedSince: Date;
  limit: number;
  organizationId: string;
}) {
  const recent = and(
    eq(automationRuns.automationId, input.automationId),
    eq(automationRuns.organizationId, input.organizationId),
    or(
      inArray(automationRuns.status, ["pending", "running"]),
      gte(automationRuns.completedAt, input.finishedSince),
    ),
  );
  const [runs, [total]] = await Promise.all([
    getDatabase()
      .select({
        completedAt: automationRuns.completedAt,
        createdAt: automationRuns.createdAt,
        id: automationRuns.id,
        issueId: automationIssueRuns.issueId,
        relationship: automationIssueRuns.relationship,
        startedAt: automationRuns.startedAt,
        status: automationRuns.status,
        title: sql<string | null>`${automationRuns.triggerInput}->>'title'`,
      })
      .from(automationRuns)
      .leftJoin(automationIssueRuns, eq(automationIssueRuns.runId, automationRuns.id))
      .where(recent)
      .orderBy(asc(automationRuns.createdAt), asc(automationRuns.id))
      .limit(input.limit),
    getDatabase().select({ value: count() }).from(automationRuns).where(recent),
  ]);
  return { runs, total: total?.value ?? runs.length };
}
