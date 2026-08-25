import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { IssuePullRequestActivityEvent } from "./schema.js";
import { getDatabase } from "./client.js";
import {
  activeIssuePullRequestIndexPredicate,
  agentConfigVersions,
  agents,
  instanceConfiguration,
  integrationAccounts,
  investigationIssues,
  investigations,
  issuePullRequestActivities,
  issuePullRequestSlackMessages,
  issuePullRequests,
  issues,
  runtimeProfiles,
} from "./schema.js";

type IssuePullRequestTransaction = Parameters<
  Parameters<ReturnType<typeof getDatabase>["transaction"]>[0]
>[0];

const activeIssuePullRequestStatuses = [
  "queued",
  "creating",
  "created",
] as const;

export class IssuePullRequestError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "issue_not_found"
      | "not_available"
      | "remediation_not_found"
      | "already_requested"
      | "request_not_found",
  ) {
    super(message);
    this.name = "IssuePullRequestError";
  }
}

async function prepareIssuePullRequestWrite(
  tx: IssuePullRequestTransaction,
): Promise<boolean> {
  const activeIndexResult = await tx.execute<{ available: boolean }>(sql`
    select exists (
      select 1
      from pg_catalog.pg_index
      where indexrelid = to_regclass(
        ${"public.issue_pull_requests_active_issue_idx"}
      )
        and indisvalid
        and indisunique
    ) as available
  `);
  const activeIndexAvailable = activeIndexResult.rows[0]?.available === true;

  // During a rolling/schema-first upgrade, a caller can briefly run before the
  // partial unique index exists. Serialize that compatibility path, then check
  // for an active request while holding the lock. The lock also makes this safe
  // when it races with the migration that creates the index.
  if (!activeIndexAvailable) {
    await tx.execute(
      sql`lock table ${issuePullRequests} in access exclusive mode`,
    );
  }

  return activeIndexAvailable;
}

export async function queueAutomaticIssuePullRequests(
  tx: IssuePullRequestTransaction,
  input: {
    agentConfigVersionId: string;
    investigationId: string;
    remediations: Array<{ issueId: string; remediationId: string }>;
  },
) {
  const uniqueRemediations = [
    ...new Map(
      input.remediations.map((remediation) => [
        remediation.issueId,
        remediation,
      ]),
    ).values(),
  ];
  const uniqueIssueIds = uniqueRemediations.map(
    (remediation) => remediation.issueId,
  );
  if (uniqueIssueIds.length === 0) return [];

  const activeIndexAvailable = await prepareIssuePullRequestWrite(tx);
  const existing = await tx
    .select({ issueId: issuePullRequests.issueId })
    .from(issuePullRequests)
    .where(
      and(
        inArray(issuePullRequests.issueId, uniqueIssueIds),
        inArray(issuePullRequests.status, activeIssuePullRequestStatuses),
      ),
    );
  const existingIssueIds = new Set(existing.map((request) => request.issueId));
  const requestedRemediations = uniqueRemediations.filter(
    (remediation) => !existingIssueIds.has(remediation.issueId),
  );
  if (requestedRemediations.length === 0) return [];

  const insert = tx.insert(issuePullRequests).values(
    requestedRemediations.map((remediation) => ({
      issueId: remediation.issueId,
      investigationId: input.investigationId,
      agentConfigVersionId: input.agentConfigVersionId,
      remediationId: remediation.remediationId,
    })),
  );
  return activeIndexAvailable
    ? insert
      .onConflictDoNothing({
        target: issuePullRequests.issueId,
        where: activeIssuePullRequestIndexPredicate,
      })
      .returning({ id: issuePullRequests.id, issueId: issuePullRequests.issueId })
    : insert.returning({
      id: issuePullRequests.id,
      issueId: issuePullRequests.issueId,
    });
}

export async function getIssuePullRequestState(
  organizationId: string,
  issueId: string,
) {
  const db = getDatabase();
  const [requests, eligibleInvestigations] = await Promise.all([
    db
      .select({
        id: issuePullRequests.id,
        remediationId: issuePullRequests.remediationId,
        repositoryFullName: issuePullRequests.repositoryFullName,
        status: issuePullRequests.status,
        branch: issuePullRequests.branch,
        pullRequestNumber: issuePullRequests.pullRequestNumber,
        pullRequestUrl: issuePullRequests.pullRequestUrl,
        failureReason: issuePullRequests.failureReason,
        createdAt: issuePullRequests.createdAt,
        updatedAt: issuePullRequests.updatedAt,
        completedAt: issuePullRequests.completedAt,
      })
      .from(issuePullRequests)
      .innerJoin(issues, eq(issues.id, issuePullRequests.issueId))
      .where(
        and(
          eq(issuePullRequests.issueId, issueId),
          eq(issues.organizationId, organizationId),
        ),
      )
      .orderBy(desc(issuePullRequests.createdAt)),
    db
      .select({ mode: agentConfigVersions.prMode })
      .from(investigationIssues)
      .innerJoin(
        investigations,
        eq(investigations.id, investigationIssues.investigationId),
      )
      .innerJoin(
        agents,
        eq(agents.id, investigations.agentId),
      )
      .innerJoin(
        agentConfigVersions,
        eq(agentConfigVersions.id, agents.activeVersionId),
      )
      .where(
        and(
          eq(investigationIssues.issueId, issueId),
          eq(investigations.organizationId, organizationId),
          eq(agents.enabled, true),
          eq(agentConfigVersions.prMode, "manual"),
        ),
      )
      .limit(1),
  ]);

  const activityRows = requests.length > 0
    ? await db
        .select({
          id: issuePullRequestActivities.id,
          requestId: issuePullRequestActivities.requestId,
          event: issuePullRequestActivities.event,
          createdAt: issuePullRequestActivities.createdAt,
        })
        .from(issuePullRequestActivities)
        .where(
          inArray(
            issuePullRequestActivities.requestId,
            requests.map((request) => request.id),
          ),
        )
        .orderBy(asc(issuePullRequestActivities.id))
    : [];
  const activitiesByRequest = Map.groupBy(
    activityRows,
    (activity) => activity.requestId,
  );
  const requestsWithActivities = requests.map((request) => ({
    ...request,
    activities: activitiesByRequest.get(request.id) ?? [],
  }));
  const activeRequest = requests.find((request) =>
    ["queued", "creating", "created", "merged"].includes(request.status),
  );
  return {
    canCreate: eligibleInvestigations.length > 0 && !activeRequest,
    requests: requestsWithActivities,
  };
}

export function pullRequestActivityEvent(
  type: IssuePullRequestActivityEvent["type"],
  data?: Record<string, unknown>,
  at = new Date(),
): IssuePullRequestActivityEvent {
  return {
    ...(data ? { data } : {}),
    meta: { at: at.toISOString() },
    type,
  };
}

export async function appendIssuePullRequestActivity(input: {
  event: IssuePullRequestActivityEvent;
  externalKey?: string;
  requestId: string;
}): Promise<void> {
  const insert = getDatabase()
    .insert(issuePullRequestActivities)
    .values({
      event: input.event,
      externalKey: input.externalKey,
      requestId: input.requestId,
    });
  if (input.externalKey) {
    await insert.onConflictDoNothing({
      target: [
        issuePullRequestActivities.requestId,
        issuePullRequestActivities.externalKey,
      ],
      where: sql`${issuePullRequestActivities.externalKey} is not null`,
    });
    return;
  }
  await insert;
}

export async function registerIssuePullRequestSlackMessage(input: {
  channelId: string;
  integrationAccountId: string;
  messageTimestamp: string;
  requestId: string;
}): Promise<void> {
  await getDatabase()
    .insert(issuePullRequestSlackMessages)
    .values(input)
    .onConflictDoNothing({
      target: [
        issuePullRequestSlackMessages.requestId,
        issuePullRequestSlackMessages.integrationAccountId,
        issuePullRequestSlackMessages.channelId,
        issuePullRequestSlackMessages.messageTimestamp,
      ],
    });
}

export async function getIssuePullRequestSlackCard(requestId: string) {
  const rows = await getDatabase()
    .select({
      requestId: issuePullRequests.id,
      issueId: issues.id,
      issueTitle: issues.title,
      issueSeverity: issues.severity,
      issueRemediations: issues.remediations,
      remediationId: issuePullRequests.remediationId,
      repositoryFullName: issuePullRequests.repositoryFullName,
      status: issuePullRequests.status,
      pullRequestNumber: issuePullRequests.pullRequestNumber,
      pullRequestUrl: issuePullRequests.pullRequestUrl,
      failureReason: issuePullRequests.failureReason,
    })
    .from(issuePullRequests)
    .innerJoin(issues, eq(issues.id, issuePullRequests.issueId))
    .where(eq(issuePullRequests.id, requestId))
    .limit(1);
  const request = rows[0];
  if (!request) return null;
  const selectedRemediation = request.remediationId
    ? request.issueRemediations.find(
        (remediation) => remediation.id === request.remediationId,
      )
    : undefined;
  if (!selectedRemediation) return null;
  return { ...request, selectedRemediation };
}

export async function getIssuePullRequestSlackDeliveries(requestId: string) {
  return getDatabase()
    .select({
      channelId: issuePullRequestSlackMessages.channelId,
      encryptedCredentials: integrationAccounts.encryptedCredentials,
      messageTimestamp: issuePullRequestSlackMessages.messageTimestamp,
    })
    .from(issuePullRequestSlackMessages)
    .innerJoin(
      integrationAccounts,
      eq(
        integrationAccounts.id,
        issuePullRequestSlackMessages.integrationAccountId,
      ),
    )
    .where(
      and(
        eq(issuePullRequestSlackMessages.requestId, requestId),
        eq(integrationAccounts.provider, "slack"),
        eq(integrationAccounts.status, "connected"),
      ),
    );
}

export async function queueManualIssuePullRequest(input: {
  issueId: string;
  organizationId: string;
  remediationId: string;
}) {
  const db = getDatabase();
  return db.transaction(async (tx) => {
    const issueRows = await tx
      .select({ id: issues.id, remediations: issues.remediations })
      .from(issues)
      .where(
        and(
          eq(issues.id, input.issueId),
          eq(issues.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    const issue = issueRows[0];
    if (!issue) {
      throw new IssuePullRequestError("Issue not found", "issue_not_found");
    }
    const remediation = issue.remediations.find(
      (candidate) => candidate.id === input.remediationId,
    );
    if (!remediation || remediation.type !== "code_change") {
      throw new IssuePullRequestError(
        "Code remediation not found",
        "remediation_not_found",
      );
    }

    const activeIndexAvailable = await prepareIssuePullRequestWrite(tx);

    const existing = await tx
      .select({ id: issuePullRequests.id })
      .from(issuePullRequests)
      .where(
        and(
          eq(issuePullRequests.issueId, input.issueId),
          inArray(issuePullRequests.status, [
            "queued",
            "creating",
            "created",
            "merged",
          ]),
        ),
      )
      .limit(1);
    if (existing[0]) {
      throw new IssuePullRequestError(
        "A pull request has already been requested for this issue",
        "already_requested",
      );
    }

    const eligible = await tx
      .select({
        investigationId: investigations.id,
        agentConfigVersionId: agentConfigVersions.id,
      })
      .from(investigationIssues)
      .innerJoin(
        investigations,
        eq(investigations.id, investigationIssues.investigationId),
      )
      .innerJoin(
        agents,
        eq(agents.id, investigations.agentId),
      )
      .innerJoin(
        agentConfigVersions,
        eq(agentConfigVersions.id, agents.activeVersionId),
      )
      .where(
        and(
          eq(investigationIssues.issueId, input.issueId),
          eq(investigations.organizationId, input.organizationId),
          eq(agents.enabled, true),
          eq(agentConfigVersions.prMode, "manual"),
        ),
      )
      .orderBy(desc(investigations.createdAt))
      .limit(1);
    const target = eligible[0];
    if (!target) {
      throw new IssuePullRequestError(
        "This issue is not linked to an agent configured for on-request pull requests",
        "not_available",
      );
    }

    const insert = tx
      .insert(issuePullRequests)
      .values({
        issueId: input.issueId,
        investigationId: target.investigationId,
        agentConfigVersionId: target.agentConfigVersionId,
        remediationId: remediation.id,
      });
    const inserted = activeIndexAvailable
      ? await insert
        .onConflictDoNothing({
          target: issuePullRequests.issueId,
          where: activeIssuePullRequestIndexPredicate,
        })
        .returning({ id: issuePullRequests.id })
      : await insert.returning({ id: issuePullRequests.id });
    const request = inserted[0];
    if (!request) {
      throw new IssuePullRequestError(
        "A pull request has already been requested for this issue",
        "already_requested",
      );
    }
    return request;
  });
}

export async function getIssuePullRequestForRemediation(requestId: string) {
  const rows = await getDatabase()
    .select({
      requestId: issuePullRequests.id,
      issueId: issues.id,
      issueTitle: issues.title,
      issueDescription: issues.description,
      issueRootCause: issues.rootCause,
      issueTimeline: issues.timeline,
      issueRemediation: issues.remediation,
      issueRemediations: issues.remediations,
      issueSeverity: issues.severity,
      issueEvidence: issues.evidence,
      investigationId: investigations.id,
      agentConfigVersionId: agentConfigVersions.id,
      agentId: agents.id,
      organizationId: agents.organizationId,
      runtimeProfileId: investigations.runtimeProfileId,
      remediationId: issuePullRequests.remediationId,
      status: issuePullRequests.status,
    })
    .from(issuePullRequests)
    .innerJoin(issues, eq(issues.id, issuePullRequests.issueId))
    .innerJoin(
      investigations,
      eq(investigations.id, issuePullRequests.investigationId),
    )
    .innerJoin(
      agentConfigVersions,
      eq(agentConfigVersions.id, issuePullRequests.agentConfigVersionId),
    )
    .innerJoin(agents, eq(agents.id, agentConfigVersions.agentId))
    .where(eq(issuePullRequests.id, requestId))
    .limit(1);
  const request = rows[0];
  if (!request) {
    throw new IssuePullRequestError(
      "Pull request request not found",
      "request_not_found",
    );
  }
  const selectedRemediation = request.remediationId
    ? request.issueRemediations.find(
        (remediation) => remediation.id === request.remediationId,
      )
    : undefined;
  if (request.remediationId && selectedRemediation?.type !== "code_change") {
    throw new IssuePullRequestError(
      "Code remediation not found",
      "remediation_not_found",
    );
  }

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
  return { ...request, runtimeProfileId, selectedRemediation };
}

async function transitionIssuePullRequestToCreating(
  requestId: string,
  acceptedStatuses: Array<"queued" | "creating">,
) {
  const rows = await getDatabase()
    .update(issuePullRequests)
    .set({
      status: "creating",
      failureReason: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(issuePullRequests.id, requestId),
        inArray(issuePullRequests.status, acceptedStatuses),
      ),
    )
    .returning({ id: issuePullRequests.id });
  if (!rows[0]) {
    throw new IssuePullRequestError(
      "Pull request request is no longer active",
      "request_not_found",
    );
  }
}

export async function claimIssuePullRequestForRemediation(
  requestId: string,
) {
  return transitionIssuePullRequestToCreating(requestId, ["queued"]);
}

export async function markIssuePullRequestStarted(
  requestId: string,
) {
  return transitionIssuePullRequestToCreating(requestId, [
    "queued",
    "creating",
  ]);
}

export async function setIssuePullRequestSession(
  requestId: string,
  eveSessionId: string,
) {
  await getDatabase()
    .update(issuePullRequests)
    .set({ eveSessionId, updatedAt: new Date() })
    .where(eq(issuePullRequests.id, requestId));
}

export async function getExecutableIssuePullRequest(input: {
  agentConfigVersionId: string;
  investigationId: string;
  issueId: string;
  organizationId: string;
  requestId?: string;
}) {
  const rows = await getDatabase()
    .select({
      requestId: issuePullRequests.id,
      issueTitle: issues.title,
      issueDescription: issues.description,
      issueRootCause: issues.rootCause,
      issueTimeline: issues.timeline,
      issueEvidence: issues.evidence,
      issueRemediation: issues.remediation,
      issueRemediations: issues.remediations,
      remediationId: issuePullRequests.remediationId,
      investigationEvidence: investigationIssues.evidence,
      investigationInput: investigations.input,
      status: issuePullRequests.status,
    })
    .from(issuePullRequests)
    .innerJoin(issues, eq(issues.id, issuePullRequests.issueId))
    .innerJoin(
      investigations,
      eq(investigations.id, issuePullRequests.investigationId),
    )
    .innerJoin(
      investigationIssues,
      and(
        eq(investigationIssues.issueId, issuePullRequests.issueId),
        eq(
          investigationIssues.investigationId,
          issuePullRequests.investigationId,
        ),
      ),
    )
    .where(
      and(
        eq(issuePullRequests.issueId, input.issueId),
        eq(issuePullRequests.investigationId, input.investigationId),
        eq(
          issuePullRequests.agentConfigVersionId,
          input.agentConfigVersionId,
        ),
        eq(issues.organizationId, input.organizationId),
        inArray(issuePullRequests.status, ["queued", "creating"]),
        ...(input.requestId
          ? [eq(issuePullRequests.id, input.requestId)]
          : []),
      ),
    )
    .orderBy(desc(issuePullRequests.createdAt))
    .limit(1);
  const request = rows[0];
  if (!request) {
    throw new IssuePullRequestError(
      "No active pull request request exists for this issue",
      "request_not_found",
    );
  }
  const selectedRemediation = request.remediationId
    ? request.issueRemediations.find(
        (remediation) => remediation.id === request.remediationId,
      )
    : undefined;
  return { ...request, selectedRemediation };
}

export async function markIssuePullRequestCreated(input: {
  requestId: string;
  repositoryFullName: string;
  branch: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
}) {
  await getDatabase()
    .update(issuePullRequests)
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
        eq(issuePullRequests.id, input.requestId),
        inArray(issuePullRequests.status, ["queued", "creating"]),
      ),
    );
}

export async function markIssuePullRequestMerged(input: {
  repositoryFullName: string;
  pullRequestNumber: number;
}): Promise<{
  requestId: string;
  organizationId: string;
  issueId: string;
  investigationId: string;
  agentConfigVersionId: string;
  pullRequestUrl: string | null;
} | null> {
  const db = getDatabase();
  const updated = await db
    .update(issuePullRequests)
    .set({ status: "merged", updatedAt: new Date() })
    .where(
      and(
        eq(issuePullRequests.repositoryFullName, input.repositoryFullName),
        eq(issuePullRequests.pullRequestNumber, input.pullRequestNumber),
        eq(issuePullRequests.status, "created"),
      ),
    )
    .returning({
      requestId: issuePullRequests.id,
      issueId: issuePullRequests.issueId,
      investigationId: issuePullRequests.investigationId,
      agentConfigVersionId: issuePullRequests.agentConfigVersionId,
      pullRequestUrl: issuePullRequests.pullRequestUrl,
    });
  const request = updated[0];
  if (!request) return null;

  const organizationRows = await db
    .select({ organizationId: issues.organizationId })
    .from(issues)
    .where(eq(issues.id, request.issueId))
    .limit(1);
  const organizationId = organizationRows[0]?.organizationId;
  if (!organizationId) return null;

  return { ...request, organizationId };
}

export async function getIssuePullRequestForReview(input: {
  repositoryFullName: string;
  pullRequestNumber: number;
}) {
  const rows = await getDatabase()
    .select({
      requestId: issuePullRequests.id,
      repositoryFullName: issuePullRequests.repositoryFullName,
      branch: issuePullRequests.branch,
      pullRequestNumber: issuePullRequests.pullRequestNumber,
      issueId: issues.id,
      issueTitle: issues.title,
      issueDescription: issues.description,
      issueRootCause: issues.rootCause,
      issueTimeline: issues.timeline,
      issueRemediation: issues.remediation,
      issueSeverity: issues.severity,
      issueEvidence: issues.evidence,
      investigationId: investigations.id,
      agentConfigVersionId: agentConfigVersions.id,
      runtimeProfileId: investigations.runtimeProfileId,
    })
    .from(issuePullRequests)
    .innerJoin(issues, eq(issues.id, issuePullRequests.issueId))
    .innerJoin(
      investigations,
      eq(investigations.id, issuePullRequests.investigationId),
    )
    .innerJoin(
      agentConfigVersions,
      eq(agentConfigVersions.id, issuePullRequests.agentConfigVersionId),
    )
    .where(
      and(
        eq(issuePullRequests.repositoryFullName, input.repositoryFullName),
        eq(issuePullRequests.pullRequestNumber, input.pullRequestNumber),
        eq(issuePullRequests.status, "created"),
      ),
    )
    .limit(1);
  const request = rows[0];
  const branch = request?.branch;
  if (!request || !branch) return null;

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

  return { ...request, branch, runtimeProfileId };
}

export async function failIssuePullRequest(
  requestId: string,
  failureReason: string,
) {
  await getDatabase()
    .update(issuePullRequests)
    .set({
      status: "failed",
      failureReason,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(issuePullRequests.id, requestId),
        inArray(issuePullRequests.status, ["queued", "creating"]),
      ),
    );
}

export async function listStaleCreatingIssuePullRequests(staleBefore: Date) {
  return getDatabase()
    .select({ requestId: issuePullRequests.id })
    .from(issuePullRequests)
    .where(
      and(
        eq(issuePullRequests.status, "creating"),
        lt(issuePullRequests.updatedAt, staleBefore),
      ),
    )
    .limit(100);
}

export async function recoverAbandonedIssuePullRequest(
  requestId: string,
  staleBefore: Date,
): Promise<boolean> {
  const recovered = await getDatabase()
    .update(issuePullRequests)
    .set({
      status: "failed",
      failureReason: "Remediation worker stopped before recording a result",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(issuePullRequests.id, requestId),
        eq(issuePullRequests.status, "creating"),
        lt(issuePullRequests.updatedAt, staleBefore),
      ),
    )
    .returning({ id: issuePullRequests.id });
  return recovered.length > 0;
}

export async function failPendingInvestigationPullRequests(
  investigationId: string,
  failureReason: string,
) {
  await getDatabase()
    .update(issuePullRequests)
    .set({
      status: "failed",
      failureReason,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(issuePullRequests.investigationId, investigationId),
        inArray(issuePullRequests.status, ["queued", "creating"]),
      ),
    );
}
