import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { SuggestionSubmission } from "../suggestions/model.js";
import { getDatabase } from "./client.js";
import {
  investigations,
  investigationIssues,
  issues,
  suggestionPullRequests,
  suggestionSettings,
  suggestions,
} from "./schema.js";

export interface SuggestionEmbedding {
  model: string;
  vector: number[];
}

export interface SuggestionSearchCandidate {
  id: string;
  title: string;
  subtitle: string;
  detail: string;
  codeChange: typeof suggestions.$inferSelect.codeChange;
  embedding: number[] | null;
  embeddingModel: string | null;
  createdAt: Date;
}

function normalizedSuggestionText(input: SuggestionSubmission): string {
  return JSON.stringify(
    [input.title, input.subtitle, input.detail].map((value) =>
      value
        .toLocaleLowerCase("en-US")
        .replace(/\s+/gu, " ")
        .trim()
    ),
  );
}

export function suggestionFingerprint(input: SuggestionSubmission): string {
  return createHash("sha256").update(normalizedSuggestionText(input)).digest("hex");
}

export function suggestionEmbeddingText(input: Pick<
  SuggestionSubmission,
  "detail" | "subtitle" | "title"
>): string {
  return `${input.title}\n${input.subtitle}\n${input.detail}`;
}

export function suggestionSearchPattern(query: string): string {
  return `%${query.trim()
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_")}%`;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return -1;
  let dot = 0;
  let leftLength = 0;
  let rightLength = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftLength += leftValue * leftValue;
    rightLength += rightValue * rightValue;
  }
  if (leftLength === 0 || rightLength === 0) return -1;
  return dot / (Math.sqrt(leftLength) * Math.sqrt(rightLength));
}

export async function listSuggestionSearchCandidates(
  organizationId: string,
  limit = 250,
): Promise<SuggestionSearchCandidate[]> {
  return getDatabase()
    .select({
      id: suggestions.id,
      title: suggestions.title,
      subtitle: suggestions.subtitle,
      detail: suggestions.detail,
      codeChange: suggestions.codeChange,
      embedding: suggestions.embedding,
      embeddingModel: suggestions.embeddingModel,
      createdAt: suggestions.createdAt,
    })
    .from(suggestions)
    .where(eq(suggestions.organizationId, organizationId))
    .orderBy(desc(suggestions.createdAt))
    .limit(limit);
}

export async function searchSuggestionsByText(
  organizationId: string,
  query: string,
  limit = 10,
): Promise<SuggestionSearchCandidate[]> {
  const pattern = suggestionSearchPattern(query);
  return getDatabase()
    .select({
      id: suggestions.id,
      title: suggestions.title,
      subtitle: suggestions.subtitle,
      detail: suggestions.detail,
      codeChange: suggestions.codeChange,
      embedding: suggestions.embedding,
      embeddingModel: suggestions.embeddingModel,
      createdAt: suggestions.createdAt,
    })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.organizationId, organizationId),
        or(
          ilike(suggestions.title, pattern),
          ilike(suggestions.subtitle, pattern),
          ilike(suggestions.detail, pattern),
        ),
      ),
    )
    .orderBy(desc(suggestions.createdAt))
    .limit(limit);
}

export async function createSuggestionIfMissing(input: {
  agentConfigVersionId: string;
  embedding: SuggestionEmbedding | null;
  investigationId: string;
  organizationId: string;
  suggestion: SuggestionSubmission;
  similarityThreshold?: number;
}) {
  const db = getDatabase();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.organizationId}))`);
    const fingerprint = suggestionFingerprint(input.suggestion);
    const exactRows = await tx
      .select({
        id: suggestions.id,
        title: suggestions.title,
        subtitle: suggestions.subtitle,
        detail: suggestions.detail,
        codeChange: suggestions.codeChange,
        embedding: suggestions.embedding,
        embeddingModel: suggestions.embeddingModel,
        createdAt: suggestions.createdAt,
      })
      .from(suggestions)
      .where(
        and(
          eq(suggestions.organizationId, input.organizationId),
          eq(suggestions.fingerprint, fingerprint),
        ),
      )
      .limit(1);
    if (exactRows[0]) {
      return { created: false as const, suggestion: exactRows[0] };
    }
    const candidates = await tx
      .select({
        id: suggestions.id,
        title: suggestions.title,
        subtitle: suggestions.subtitle,
        detail: suggestions.detail,
        codeChange: suggestions.codeChange,
        embedding: suggestions.embedding,
        embeddingModel: suggestions.embeddingModel,
        createdAt: suggestions.createdAt,
      })
      .from(suggestions)
      .where(eq(suggestions.organizationId, input.organizationId))
      .orderBy(desc(suggestions.createdAt))
      .limit(250);
    const semantic = input.embedding
      ? candidates
          .filter(
            (candidate) =>
              candidate.embeddingModel === input.embedding!.model &&
              candidate.embedding?.length === input.embedding!.vector.length,
          )
          .map((candidate) => ({
            candidate,
            score: cosineSimilarity(candidate.embedding!, input.embedding!.vector),
          }))
          .sort((left, right) => right.score - left.score)[0]
      : undefined;
    const existing = semantic && semantic.score >= (input.similarityThreshold ?? 0.9)
      ? semantic.candidate
      : undefined;
    if (existing) return { created: false as const, suggestion: existing };

    const codeChange = input.suggestion.codeChange
      ? { ...input.suggestion.codeChange, id: randomUUID() }
      : null;
    const inserted = await tx
      .insert(suggestions)
      .values({
        organizationId: input.organizationId,
        investigationId: input.investigationId,
        agentConfigVersionId: input.agentConfigVersionId,
        title: input.suggestion.title,
        subtitle: input.suggestion.subtitle,
        detail: input.suggestion.detail,
        codeChange,
        fingerprint,
        embedding: input.embedding?.vector,
        embeddingModel: input.embedding?.model,
      })
      .returning();
    return { created: true as const, suggestion: inserted[0]! };
  });
}

export type SuggestionStatus = "open" | "applied" | "dismissed";

const suggestionStatus = sql<SuggestionStatus>`case
  when ${suggestions.dismissedAt} is not null then 'dismissed'
  when exists (select 1 from ${suggestionPullRequests} pr where pr.suggestion_id = ${suggestions.id} and pr.status = 'merged')
    and not exists (select 1 from ${suggestionPullRequests} pr where pr.suggestion_id = ${suggestions.id} and pr.status in ('queued', 'creating', 'created'))
    then 'applied'
  else 'open' end`;
const suggestionSource = sql<string>`coalesce(${investigations.input}->>'provider', 'unknown')`;

export async function setSuggestionDismissed(organizationId: string, suggestionId: string, dismissed: boolean): Promise<{ id: string } | null> {
  const rows = await getDatabase().update(suggestions)
    .set({ dismissedAt: dismissed ? new Date() : null, updatedAt: new Date() })
    .where(and(eq(suggestions.organizationId, organizationId), eq(suggestions.id, suggestionId)))
    .returning({ id: suggestions.id });
  return rows[0] ?? null;
}

export async function getSuggestionFilters(organizationId: string) {
  const rows = await getDatabase().select({
    status: suggestionStatus,
    source: suggestionSource,
    count: sql<number>`count(*)::int`,
  }).from(suggestions)
    .innerJoin(investigations, and(eq(investigations.id, suggestions.investigationId), eq(investigations.organizationId, organizationId)))
    .where(eq(suggestions.organizationId, organizationId))
    .groupBy(suggestionStatus, suggestionSource);
  return rows;
}

export async function listSuggestions(
  organizationId: string,
  options: {
    cursor?: { createdAt: string; id: string };
    limit?: number;
    status?: SuggestionStatus;
    source?: string;
  } = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const rows = await getDatabase()
    .select({
      id: suggestions.id,
      status: suggestionStatus,
      source: suggestionSource,
      title: suggestions.title,
      subtitle: suggestions.subtitle,
      codeChangeAvailable: sql<boolean>`${suggestions.codeChange} is not null`,
      createdAt: suggestions.createdAt,
      cursorCreatedAt: sql<string>`to_char(${suggestions.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(suggestions)
    .innerJoin(investigations, and(eq(investigations.id, suggestions.investigationId), eq(investigations.organizationId, organizationId)))
    .where(
      and(
        eq(suggestions.organizationId, organizationId),
        ...(options.status ? [sql`${suggestionStatus} = ${options.status}`] : []),
        ...(options.source ? [sql`${suggestionSource} = ${options.source}`] : []),
        ...(options.cursor
          ? [sql`(${suggestions.createdAt}, ${suggestions.id}) < (${options.cursor.createdAt}::timestamptz, ${options.cursor.id})`]
          : []),
      ),
    )
    .orderBy(desc(suggestions.createdAt), desc(suggestions.id))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  const page = pageRows.map((row) => ({
    id: row.id,
    status: row.status,
    source: row.source,
    title: row.title,
    subtitle: row.subtitle,
    codeChangeAvailable: row.codeChangeAvailable,
    createdAt: row.createdAt,
  }));
  const last = pageRows.at(-1);
  return {
    suggestions: page,
    nextCursor: rows.length > limit && last
      ? { createdAt: last.cursorCreatedAt, id: last.id }
      : null,
  };
}

export async function getSuggestionDetail(
  organizationId: string,
  suggestionId: string,
) {
  const rows = await getDatabase()
    .select({
      id: suggestions.id,
      status: suggestionStatus,
      source: suggestionSource,
      title: suggestions.title,
      subtitle: suggestions.subtitle,
      detail: suggestions.detail,
      investigationId: suggestions.investigationId,
      codeChange: suggestions.codeChange,
      createdAt: suggestions.createdAt,
    })
    .from(suggestions)
    .innerJoin(investigations, and(eq(investigations.id, suggestions.investigationId), eq(investigations.organizationId, organizationId)))
    .where(
      and(
        eq(suggestions.organizationId, organizationId),
        eq(suggestions.id, suggestionId),
      ),
    )
    .limit(1);
  if (!rows[0]) return null;
  const pullRequests = await getDatabase()
    .select({
      id: suggestionPullRequests.id,
      repositoryFullName: suggestionPullRequests.repositoryFullName,
      status: suggestionPullRequests.status,
      branch: suggestionPullRequests.branch,
      pullRequestNumber: suggestionPullRequests.pullRequestNumber,
      pullRequestUrl: suggestionPullRequests.pullRequestUrl,
      failureReason: suggestionPullRequests.failureReason,
      createdAt: suggestionPullRequests.createdAt,
      updatedAt: suggestionPullRequests.updatedAt,
      completedAt: suggestionPullRequests.completedAt,
    })
    .from(suggestionPullRequests)
    .where(eq(suggestionPullRequests.suggestionId, suggestionId))
    .orderBy(desc(suggestionPullRequests.createdAt));
  const relatedIssues = await getDatabase().select({ id: issues.id, title: issues.title, createdAt: issues.createdAt })
    .from(investigationIssues)
    .innerJoin(issues, eq(issues.id, investigationIssues.issueId))
    .where(and(eq(investigationIssues.investigationId, rows[0].investigationId), eq(issues.organizationId, organizationId)));
  return { suggestion: { ...rows[0], relatedIssues }, pullRequestState: { requests: pullRequests } };
}

export async function getSuggestionSettings(organizationId: string) {
  const rows = await getDatabase()
    .select({ autoOpenPullRequests: suggestionSettings.autoOpenPullRequests })
    .from(suggestionSettings)
    .where(eq(suggestionSettings.organizationId, organizationId))
    .limit(1);
  return { autoOpenPullRequests: rows[0]?.autoOpenPullRequests ?? false };
}

export async function setSuggestionSettings(input: {
  autoOpenPullRequests: boolean;
  organizationId: string;
}) {
  const rows = await getDatabase()
    .insert(suggestionSettings)
    .values(input)
    .onConflictDoUpdate({
      target: suggestionSettings.organizationId,
      set: {
        autoOpenPullRequests: input.autoOpenPullRequests,
        updatedAt: new Date(),
      },
    })
    .returning({ autoOpenPullRequests: suggestionSettings.autoOpenPullRequests });
  return rows[0]!;
}

export async function listQueuedSuggestionPullRequestIds(): Promise<string[]> {
  const rows = await getDatabase()
    .select({ id: suggestionPullRequests.id })
    .from(suggestionPullRequests)
    .where(eq(suggestionPullRequests.status, "queued"))
    .limit(100);
  return rows.map((row) => row.id);
}
