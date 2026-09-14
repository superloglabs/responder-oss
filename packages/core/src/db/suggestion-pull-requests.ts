import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { getDatabase } from "./client.js";
import {
  agentConfigVersions,
  agents,
  instanceConfiguration,
  investigations,
  runtimeProfiles,
  suggestionPullRequests,
  suggestions,
} from "./schema.js";

export class SuggestionPullRequestError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "suggestion_not_found"
      | "not_available"
      | "already_requested"
      | "request_not_found",
  ) {
    super(message);
    this.name = "SuggestionPullRequestError";
  }
}

export async function queueSuggestionPullRequests(input: {
  organizationId: string;
  suggestionId: string;
}) {
  const db = getDatabase();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: suggestions.id,
        codeChange: suggestions.codeChange,
        investigationId: suggestions.investigationId,
        agentConfigVersionId: suggestions.agentConfigVersionId,
      })
      .from(suggestions)
      .where(
        and(
          eq(suggestions.id, input.suggestionId),
          eq(suggestions.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    const suggestion = rows[0];
    if (!suggestion) {
      throw new SuggestionPullRequestError(
        "Suggestion not found",
        "suggestion_not_found",
      );
    }
    if (!suggestion.codeChange) {
      throw new SuggestionPullRequestError(
        "This suggestion does not have a code change",
        "not_available",
      );
    }
    const existing = await tx
      .select({ id: suggestionPullRequests.id })
      .from(suggestionPullRequests)
      .where(
        and(
          eq(suggestionPullRequests.suggestionId, suggestion.id),
          inArray(suggestionPullRequests.status, [
            "queued",
            "creating",
            "created",
            "merged",
          ]),
        ),
      )
      .limit(1);
    if (existing[0]) {
      throw new SuggestionPullRequestError(
        "A pull request has already been requested for this suggestion",
        "already_requested",
      );
    }
    const inserted = await tx
      .insert(suggestionPullRequests)
      .values(
        suggestion.codeChange.changes.map((change) => ({
          suggestionId: suggestion.id,
          investigationId: suggestion.investigationId,
          agentConfigVersionId: suggestion.agentConfigVersionId,
          repositoryFullName: change.repository,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: suggestionPullRequests.id });
    if (inserted.length !== suggestion.codeChange.changes.length) {
      throw new SuggestionPullRequestError(
        "A pull request has already been requested for this suggestion",
        "already_requested",
      );
    }
    return inserted;
  });
}

export async function getSuggestionPullRequestForRemediation(requestId: string) {
  const rows = await getDatabase()
    .select({
      requestId: suggestionPullRequests.id,
      suggestionId: suggestions.id,
      suggestionTitle: suggestions.title,
      suggestionSubtitle: suggestions.subtitle,
      suggestionDetail: suggestions.detail,
      codeChange: suggestions.codeChange,
      investigationId: investigations.id,
      agentConfigVersionId: agentConfigVersions.id,
      organizationId: agents.organizationId,
      runtimeProfileId: investigations.runtimeProfileId,
      repositoryFullName: suggestionPullRequests.repositoryFullName,
      status: suggestionPullRequests.status,
    })
    .from(suggestionPullRequests)
    .innerJoin(suggestions, eq(suggestions.id, suggestionPullRequests.suggestionId))
    .innerJoin(
      investigations,
      eq(investigations.id, suggestionPullRequests.investigationId),
    )
    .innerJoin(
      agentConfigVersions,
      eq(agentConfigVersions.id, suggestionPullRequests.agentConfigVersionId),
    )
    .innerJoin(agents, eq(agents.id, agentConfigVersions.agentId))
    .where(eq(suggestionPullRequests.id, requestId))
    .limit(1);
  const request = rows[0];
  if (!request) {
    throw new SuggestionPullRequestError(
      "Pull request request not found",
      "request_not_found",
    );
  }
  if (!request.codeChange) {
    throw new SuggestionPullRequestError(
      "This suggestion does not have a code change",
      "not_available",
    );
  }
  const codeChange = request.codeChange;
  let runtimeProfileId = request.runtimeProfileId;
  if (!runtimeProfileId) {
    const activeProfiles = await getDatabase()
      .select({ id: runtimeProfiles.id })
      .from(instanceConfiguration)
      .innerJoin(
        runtimeProfiles,
        eq(runtimeProfiles.id, instanceConfiguration.activeRuntimeProfileId),
      )
      .where(eq(instanceConfiguration.id, "default"))
      .limit(1);
    runtimeProfileId = activeProfiles[0]?.id ?? null;
  }
  if (!runtimeProfileId) {
    throw new Error("The Responder instance does not have an active runtime profile");
  }
  return { ...request, codeChange, runtimeProfileId };
}

export async function getExecutableSuggestionPullRequest(input: {
  agentConfigVersionId: string;
  investigationId: string;
  organizationId: string;
  requestId: string;
  suggestionId: string;
}) {
  const rows = await getDatabase()
    .select({
      requestId: suggestionPullRequests.id,
      codeChange: suggestions.codeChange,
      status: suggestionPullRequests.status,
    })
    .from(suggestionPullRequests)
    .innerJoin(suggestions, eq(suggestions.id, suggestionPullRequests.suggestionId))
    .where(
      and(
        eq(suggestionPullRequests.id, input.requestId),
        eq(suggestionPullRequests.suggestionId, input.suggestionId),
        eq(suggestionPullRequests.investigationId, input.investigationId),
        eq(
          suggestionPullRequests.agentConfigVersionId,
          input.agentConfigVersionId,
        ),
        eq(suggestions.organizationId, input.organizationId),
        inArray(suggestionPullRequests.status, ["queued", "creating"]),
      ),
    )
    .limit(1);
  const request = rows[0];
  if (!request?.codeChange) {
    throw new SuggestionPullRequestError(
      "No active pull request request exists for this suggestion",
      "request_not_found",
    );
  }
  return request;
}

async function transitionToCreating(
  requestId: string,
  acceptedStatuses: Array<"queued" | "creating">,
) {
  const rows = await getDatabase()
    .update(suggestionPullRequests)
    .set({ status: "creating", failureReason: null, updatedAt: new Date() })
    .where(
      and(
        eq(suggestionPullRequests.id, requestId),
        inArray(suggestionPullRequests.status, acceptedStatuses),
      ),
    )
    .returning({ id: suggestionPullRequests.id });
  if (!rows[0]) {
    throw new SuggestionPullRequestError(
      "Pull request request is no longer active",
      "request_not_found",
    );
  }
}

export function claimSuggestionPullRequestForRemediation(requestId: string) {
  return transitionToCreating(requestId, ["queued"]);
}

export function markSuggestionPullRequestStarted(requestId: string) {
  return transitionToCreating(requestId, ["queued", "creating"]);
}

export async function setSuggestionPullRequestSession(
  requestId: string,
  eveSessionId: string,
) {
  await getDatabase()
    .update(suggestionPullRequests)
    .set({ eveSessionId, updatedAt: new Date() })
    .where(eq(suggestionPullRequests.id, requestId));
}

export async function markSuggestionPullRequestCreated(input: {
  branch: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  repositoryFullName: string;
  requestId: string;
}) {
  await getDatabase()
    .update(suggestionPullRequests)
    .set({
      status: "created",
      repositoryFullName: input.repositoryFullName,
      branch: input.branch,
      pullRequestNumber: input.pullRequestNumber,
      pullRequestUrl: input.pullRequestUrl,
      failureReason: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(suggestionPullRequests.id, input.requestId),
        inArray(suggestionPullRequests.status, ["queued", "creating"]),
      ),
    );
}

export async function markSuggestionPullRequestMerged(input: {
  pullRequestNumber: number;
  repositoryFullName: string;
}) {
  const db = getDatabase();
  const rows = await db
    .update(suggestionPullRequests)
    .set({ status: "merged", updatedAt: new Date() })
    .where(
      and(
        eq(suggestionPullRequests.repositoryFullName, input.repositoryFullName),
        eq(suggestionPullRequests.pullRequestNumber, input.pullRequestNumber),
        eq(suggestionPullRequests.status, "created"),
      ),
    )
    .returning({
      requestId: suggestionPullRequests.id,
      suggestionId: suggestionPullRequests.suggestionId,
      investigationId: suggestionPullRequests.investigationId,
      agentConfigVersionId: suggestionPullRequests.agentConfigVersionId,
      pullRequestUrl: suggestionPullRequests.pullRequestUrl,
    });
  const request = rows[0];
  if (!request) return null;
  const organizationRows = await db
    .select({ organizationId: suggestions.organizationId })
    .from(suggestions)
    .where(eq(suggestions.id, request.suggestionId))
    .limit(1);
  const organizationId = organizationRows[0]?.organizationId;
  return organizationId ? { ...request, organizationId } : null;
}

export async function failSuggestionPullRequest(
  requestId: string,
  failureReason: string,
) {
  await getDatabase()
    .update(suggestionPullRequests)
    .set({
      status: "failed",
      failureReason,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(suggestionPullRequests.id, requestId),
        inArray(suggestionPullRequests.status, ["queued", "creating"]),
      ),
    );
}

export async function listStaleCreatingSuggestionPullRequests(staleBefore: Date) {
  return getDatabase()
    .select({ requestId: suggestionPullRequests.id })
    .from(suggestionPullRequests)
    .where(
      and(
        eq(suggestionPullRequests.status, "creating"),
        lt(suggestionPullRequests.updatedAt, staleBefore),
      ),
    )
    .orderBy(desc(suggestionPullRequests.updatedAt));
}

export async function recoverAbandonedSuggestionPullRequest(
  requestId: string,
  staleBefore: Date,
) {
  const rows = await getDatabase()
    .update(suggestionPullRequests)
    .set({
      status: "failed",
      failureReason: "Pull request creation was abandoned before completion",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(suggestionPullRequests.id, requestId),
        eq(suggestionPullRequests.status, "creating"),
        lt(suggestionPullRequests.updatedAt, staleBefore),
      ),
    )
    .returning({ id: suggestionPullRequests.id });
  return rows.length > 0;
}
