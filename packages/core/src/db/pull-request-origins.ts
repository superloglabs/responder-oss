import { and, desc, eq, sql } from "drizzle-orm";
import { getDatabase } from "./client.js";
import {
  automationRuns,
  automations,
  investigations,
  pullRequestOrigins,
  slackInvestigationSessions,
} from "./schema.js";

// The thread or run a pull request belongs to. Exactly one is set.
export type PullRequestOwner =
  | { automationRunId: string; slackInvestigationSessionId?: undefined }
  | { automationRunId?: undefined; slackInvestigationSessionId: string };

// Reviews from bots stop starting turns after this many, so a reviewer that
// comments on every commit cannot keep an agent pushing forever.
export const maxBotReviewTurns = 5;

// Safe to call again for the same pull request.
export async function recordPullRequestOrigin(input: PullRequestOwner & {
  organizationId: string;
  pullRequestNumber: number;
  repositoryFullName: string;
}): Promise<void> {
  await getDatabase()
    .insert(pullRequestOrigins)
    .values({
      automationRunId: input.automationRunId ?? null,
      organizationId: input.organizationId,
      pullRequestNumber: input.pullRequestNumber,
      repositoryFullName: input.repositoryFullName,
      slackInvestigationSessionId: input.slackInvestigationSessionId ?? null,
    })
    .onConflictDoNothing({
      target: [
        pullRequestOrigins.repositoryFullName,
        pullRequestOrigins.pullRequestNumber,
      ],
    });
}

// The pull request, when the given thread or run opened it.
export async function getOwnedPullRequest(input: PullRequestOwner & {
  pullRequestNumber: number;
  repositoryFullName: string;
}) {
  const rows = await getDatabase()
    .select({
      pullRequestNumber: pullRequestOrigins.pullRequestNumber,
      repositoryFullName: pullRequestOrigins.repositoryFullName,
    })
    .from(pullRequestOrigins)
    .where(and(
      eq(pullRequestOrigins.repositoryFullName, input.repositoryFullName),
      eq(pullRequestOrigins.pullRequestNumber, input.pullRequestNumber),
      input.slackInvestigationSessionId !== undefined
        ? eq(
            pullRequestOrigins.slackInvestigationSessionId,
            input.slackInvestigationSessionId,
          )
        : eq(pullRequestOrigins.automationRunId, input.automationRunId),
    ))
    .limit(1);
  return rows[0] ?? null;
}

export interface PullRequestReviewTarget {
  botReviewTurns: number;
  id: string;
  organizationId: string;
  // Set for a pull request an automation run opened.
  automationRun: { automationEnabled: boolean; id: string } | null;
  // Set for a pull request a tag mode thread opened. The latest turn's input
  // says where the thread is, so a new turn answers in the same place.
  thread: {
    agentId: string;
    channelId: string;
    id: string;
    latestInput: typeof investigations.$inferSelect.input | null;
    teamId: string;
    threadTimestamp: string;
  } | null;
}

export async function findPullRequestReviewTarget(input: {
  pullRequestNumber: number;
  repositoryFullName: string;
}): Promise<PullRequestReviewTarget | null> {
  const db = getDatabase();
  const rows = await db
    .select({
      automationEnabled: automations.enabled,
      automationRunId: pullRequestOrigins.automationRunId,
      botReviewTurns: pullRequestOrigins.botReviewTurns,
      id: pullRequestOrigins.id,
      organizationId: pullRequestOrigins.organizationId,
      sessionAgentId: slackInvestigationSessions.agentId,
      sessionChannelId: slackInvestigationSessions.channelId,
      sessionId: slackInvestigationSessions.id,
      sessionTeamId: slackInvestigationSessions.teamId,
      sessionThreadTimestamp: slackInvestigationSessions.threadTimestamp,
    })
    .from(pullRequestOrigins)
    .leftJoin(
      slackInvestigationSessions,
      eq(slackInvestigationSessions.id, pullRequestOrigins.slackInvestigationSessionId),
    )
    .leftJoin(automationRuns, eq(automationRuns.id, pullRequestOrigins.automationRunId))
    .leftJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(and(
      eq(pullRequestOrigins.repositoryFullName, input.repositoryFullName),
      eq(pullRequestOrigins.pullRequestNumber, input.pullRequestNumber),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  let thread: PullRequestReviewTarget["thread"] = null;
  if (
    row.sessionId &&
    row.sessionAgentId &&
    row.sessionTeamId &&
    row.sessionChannelId &&
    row.sessionThreadTimestamp
  ) {
    const latest = await db
      .select({ input: investigations.input })
      .from(investigations)
      .where(eq(investigations.slackInvestigationSessionId, row.sessionId))
      .orderBy(desc(investigations.createdAt))
      .limit(1);
    thread = {
      agentId: row.sessionAgentId,
      channelId: row.sessionChannelId,
      id: row.sessionId,
      latestInput: latest[0]?.input ?? null,
      teamId: row.sessionTeamId,
      threadTimestamp: row.sessionThreadTimestamp,
    };
  }
  return {
    automationRun: row.automationRunId
      ? { automationEnabled: row.automationEnabled === true, id: row.automationRunId }
      : null,
    botReviewTurns: row.botReviewTurns,
    id: row.id,
    organizationId: row.organizationId,
    thread,
  };
}

// Counts a turn a bot's review started. Called once the turn is queued, so a
// redelivered review does not use up the pull request's bot turns.
export async function countBotReviewTurn(originId: string): Promise<void> {
  await getDatabase()
    .update(pullRequestOrigins)
    .set({
      botReviewTurns: sql`${pullRequestOrigins.botReviewTurns} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(pullRequestOrigins.id, originId));
}
