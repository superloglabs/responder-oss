import { and, desc, eq, inArray } from "drizzle-orm";
import { getDatabase } from "./client.js";
import {
  agentConfigVersions,
  agents,
  instanceConfiguration,
  investigationIssues,
  investigations,
  issuePullRequests,
  issues,
  runtimeProfiles,
} from "./schema.js";

export class IssuePullRequestError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "issue_not_found"
      | "not_available"
      | "already_requested"
      | "request_not_found",
  ) {
    super(message);
    this.name = "IssuePullRequestError";
  }
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

  const activeRequest = requests.find((request) =>
    ["queued", "creating", "created", "merged"].includes(request.status),
  );
  return {
    canCreate: eligibleInvestigations.length > 0 && !activeRequest,
    requests,
  };
}

export async function queueManualIssuePullRequest(input: {
  issueId: string;
  organizationId: string;
}) {
  const db = getDatabase();
  return db.transaction(async (tx) => {
    const issueRows = await tx
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.id, input.issueId),
          eq(issues.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    if (!issueRows[0]) {
      throw new IssuePullRequestError("Issue not found", "issue_not_found");
    }

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

    const inserted = await tx
      .insert(issuePullRequests)
      .values({
        issueId: input.issueId,
        investigationId: target.investigationId,
        agentConfigVersionId: target.agentConfigVersionId,
      })
      .returning({ id: issuePullRequests.id });
    return inserted[0]!;
  });
}

export async function getIssuePullRequestForRemediation(requestId: string) {
  const rows = await getDatabase()
    .select({
      requestId: issuePullRequests.id,
      issueId: issues.id,
      issueTitle: issues.title,
      issueDescription: issues.description,
      issueRemediation: issues.remediation,
      issueSeverity: issues.severity,
      issueEvidence: issues.evidence,
      investigationId: investigations.id,
      agentConfigVersionId: agentConfigVersions.id,
      agentId: agents.id,
      organizationId: agents.organizationId,
      runtimeProfileId: investigations.runtimeProfileId,
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
  return { ...request, runtimeProfileId };
}

export async function markIssuePullRequestStarted(
  requestId: string,
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
        inArray(issuePullRequests.status, ["queued", "creating"]),
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
      issueRemediation: issues.remediation,
      status: issuePullRequests.status,
    })
    .from(issuePullRequests)
    .innerJoin(issues, eq(issues.id, issuePullRequests.issueId))
    .innerJoin(
      investigations,
      eq(investigations.id, issuePullRequests.investigationId),
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
  return request;
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
