import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import type {
  InvestigationReportSubmission,
  IssueEvidence,
  IssueRemediation,
  StructuredInvestigationReport,
} from "../investigations/report.js";
import {
  codeChangeParts,
  remediationSummary,
  renderInvestigationReportMarkdown,
} from "../investigations/report.js";
import { getDatabase } from "./client.js";
import {
  agentConfigVersions,
  agents,
  integrationAccounts,
  investigationIssues,
  investigations,
  issueLinearTickets,
  issuePullRequests,
  issues,
  type AgentPrMode,
  type InvestigationSlackTraceItem,
} from "./schema.js";
import {
  getIssuePullRequestState,
  queueAutomaticIssuePullRequests,
} from "./pull-requests.js";

export interface IssueEmbedding {
  model: string;
  vector: number[];
}

export interface PreparedInvestigationReportSubmission {
  report: InvestigationReportSubmission;
  newIssueEmbeddings: Array<IssueEmbedding | null>;
}

export function issueEmbeddingText(issue: {
  title: string;
  description: string;
  rootCause?: string;
  timeline?: Array<{ title: string; description: string }>;
  remediation?: string;
}): string {
  return [
    `Title: ${issue.title}`,
    `Description: ${issue.description}`,
    issue.rootCause ? `Root cause: ${issue.rootCause}` : null,
    issue.timeline?.length
      ? `Timeline:\n${issue.timeline
          .map((entry) => `- ${entry.title}: ${entry.description}`)
          .join("\n")}`
      : null,
    issue.remediation ? `Remediation: ${issue.remediation}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

export async function listIssueSearchCandidates(
  organizationId: string,
  limit = 1_000,
) {
  return getDatabase()
    .select({
      id: issues.id,
      title: issues.title,
      description: issues.description,
      rootCause: issues.rootCause,
      timeline: issues.timeline,
      severity: issues.severity,
      remediation: issues.remediation,
      evidence: issues.evidence,
      embedding: issues.embedding,
      embeddingModel: issues.embeddingModel,
      createdAt: issues.createdAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.organizationId, organizationId),
        isNull(issues.archivedAt),
      ),
    )
    .orderBy(desc(issues.createdAt))
    .limit(limit);
}

export async function searchIssuesByText(
  organizationId: string,
  query: string,
  limit: number,
) {
  const pattern = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  return getDatabase()
    .select({
      id: issues.id,
      title: issues.title,
      description: issues.description,
      rootCause: issues.rootCause,
      timeline: issues.timeline,
      severity: issues.severity,
      remediation: issues.remediation,
      evidence: issues.evidence,
      createdAt: issues.createdAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.organizationId, organizationId),
        isNull(issues.archivedAt),
        or(
          ilike(issues.title, pattern),
          ilike(issues.description, pattern),
          ilike(issues.rootCause, pattern),
          sql`exists (
            select 1
            from jsonb_array_elements(${issues.timeline}) as timeline_entry
            where timeline_entry->>'title' ilike ${pattern}
              or timeline_entry->>'description' ilike ${pattern}
          )`,
          ilike(issues.remediation, pattern),
          sql`exists (
            select 1
            from jsonb_array_elements(${issues.remediations}) as remediation_option
            where remediation_option->>'title' ilike ${pattern}
              or remediation_option->>'description' ilike ${pattern}
              or remediation_option->>'agentPrompt' ilike ${pattern}
          )`,
        ),
      ),
    )
    .orderBy(desc(issues.createdAt))
    .limit(limit);
}

export async function submitInvestigationReport(input: {
  investigationId: string;
  organizationId: string;
  submission: PreparedInvestigationReportSubmission;
}) {
  const db = getDatabase();
  return db.transaction(async (tx) => {
    const investigationRows = await tx
      .select({
        id: investigations.id,
        status: investigations.status,
        agentConfigVersionId: investigations.agentConfigVersionId,
        prMode: agentConfigVersions.prMode,
        contextAccountIds: agentConfigVersions.contextAccountIds,
        createLinearTickets: agentConfigVersions.createLinearTickets,
        linearIssueTemplate: agentConfigVersions.linearIssueTemplate,
      })
      .from(investigations)
      .innerJoin(
        agentConfigVersions,
        eq(agentConfigVersions.id, investigations.agentConfigVersionId),
      )
      .where(
        and(
          eq(investigations.id, input.investigationId),
          eq(investigations.organizationId, input.organizationId),
        ),
      )
      .limit(1)
      .for("update", { of: investigations });
    const investigation = investigationRows[0];
    if (!investigation) throw new Error("Investigation not found");
    if (
      investigation.status !== "pending" &&
      investigation.status !== "investigating"
    ) {
      throw new Error("Investigation report has already been submitted");
    }

    const hasNewIssues = input.submission.report.issues.some(
      (issue) => issue.resolution === "new",
    );
    const linearAccount = investigation.createLinearTickets && hasNewIssues
      ? (
          await tx
            .select({ id: integrationAccounts.id })
            .from(integrationAccounts)
            .where(
              and(
                eq(integrationAccounts.organizationId, input.organizationId),
                eq(integrationAccounts.provider, "linear"),
                inArray(
                  integrationAccounts.id,
                  investigation.contextAccountIds,
                ),
              ),
            )
            .limit(1)
        )[0]
      : null;
    if (investigation.createLinearTickets && hasNewIssues && !linearAccount) {
      throw new Error("The configured Linear connection is unavailable");
    }
    const existingIds = input.submission.report.issues
      .filter((issue) => issue.resolution === "existing")
      .map((issue) => issue.issueId);
    const existingRows = existingIds.length
      ? await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.organizationId, input.organizationId),
              isNull(issues.archivedAt),
              inArray(issues.id, existingIds),
            ),
          )
      : [];
    const canonicalById = new Map(existingRows.map((issue) => [issue.id, issue]));
    if (canonicalById.size !== new Set(existingIds).size) {
      throw new Error("One or more existing issues are unavailable");
    }

    const references: StructuredInvestigationReport["issues"] = [];
    let newIssueIndex = 0;
    for (const submittedIssue of input.submission.report.issues) {
      if (submittedIssue.resolution === "existing") {
        references.push({
          issueId: submittedIssue.issueId,
          relationship: "recurrence",
          evidence: submittedIssue.evidence,
        });
        continue;
      }

      const embedding = input.submission.newIssueEmbeddings[newIssueIndex] ?? null;
      newIssueIndex += 1;
      const issueId = randomUUID();
      const remediations: IssueRemediation[] = submittedIssue.remediations.map(
        (remediation) => ({ ...remediation, id: randomUUID() }),
      );
      const inserted = await tx
        .insert(issues)
        .values({
          id: issueId,
          organizationId: input.organizationId,
          title: submittedIssue.title,
          description: submittedIssue.description,
          rootCause: submittedIssue.rootCause,
          timeline: submittedIssue.timeline,
          severity: submittedIssue.severity,
          remediation: remediationSummary(remediations),
          remediations,
          evidence: submittedIssue.evidence,
          embedding: embedding?.vector ?? null,
          embeddingModel: embedding?.model ?? null,
        })
        .returning();
      canonicalById.set(issueId, inserted[0]!);
      references.push({
        issueId,
        relationship: "new",
        evidence: submittedIssue.evidence,
      });
    }

    const report: StructuredInvestigationReport = {
      schemaVersion: 1,
      headline: input.submission.report.headline,
      summary: input.submission.report.summary,
      issues: references,
    };
    const reportIssues = references.map((reference) => {
      const issue = canonicalById.get(reference.issueId);
      if (!issue) throw new Error("Unable to resolve submitted issue");
      return issue;
    });
    const markdown = renderInvestigationReportMarkdown(report, reportIssues);
    if (references.length > 0) {
      await tx.insert(investigationIssues).values(
        references.map((reference) => ({
          investigationId: input.investigationId,
          issueId: reference.issueId,
          relationship: reference.relationship,
          evidence: reference.evidence,
        })),
      );
    }
    const candidateCodeRemediations = reportIssues.flatMap((issue) => {
      const remediation = issue.remediations.find(
        (candidate) => candidate.type === "code_change",
      );
      if (!remediation) return [];
      return codeChangeParts(remediation).map((change) => ({
        issueId: issue.id,
        remediationId: remediation.id,
        ...(change.repository ? { repositoryFullName: change.repository } : {}),
      }));
    });
    const automaticPullRequestRequests =
      investigation.prMode === "always" &&
      candidateCodeRemediations.length > 0
        ? await queueAutomaticIssuePullRequests(tx, {
            agentConfigVersionId: investigation.agentConfigVersionId,
            investigationId: input.investigationId,
            remediations: candidateCodeRemediations,
          })
        : [];
    const newIssueIds = references.flatMap((reference) =>
      reference.relationship === "new" ? [reference.issueId] : [],
    );
    const linearTicketRequests =
      linearAccount && newIssueIds.length > 0
        ? await tx
            .insert(issueLinearTickets)
            .values(
              newIssueIds.map((issueId) => ({
                issueId,
                investigationId: input.investigationId,
                agentConfigVersionId: investigation.agentConfigVersionId,
                integrationAccountId: linearAccount.id,
              })),
            )
            .returning({
              requestId: issueLinearTickets.id,
              issueId: issueLinearTickets.issueId,
            })
        : [];
    await tx
      .update(investigations)
      .set({
        status: "resolved",
        structuredReport: report,
        reportMarkdown: markdown,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(investigations.id, input.investigationId),
          eq(investigations.organizationId, input.organizationId),
          inArray(investigations.status, ["pending", "investigating"]),
        ),
      );

    return {
      report,
      issues: reportIssues.map((issue) => ({
        id: issue.id,
        title: issue.title,
        description: issue.description,
        rootCause: issue.rootCause,
        timeline: issue.timeline,
        severity: issue.severity,
        remediation: issue.remediation,
        remediations: issue.remediations,
      })),
      newIssues: references.flatMap((reference) => {
        if (reference.relationship !== "new") return [];
        const issue = canonicalById.get(reference.issueId);
        return issue
          ? [{
              id: issue.id,
              title: issue.title,
              description: issue.description,
              rootCause: issue.rootCause,
              timeline: issue.timeline,
              severity: issue.severity,
              remediation: issue.remediation,
              remediations: issue.remediations,
              evidence: issue.evidence,
            }]
          : [];
      }),
      linearTicketRequests: linearTicketRequests.map((request) => {
        const issue = canonicalById.get(request.issueId);
        if (!issue) throw new Error("Unable to resolve Linear ticket issue");
        return {
          requestId: request.requestId,
          issueId: issue.id,
          title: issue.title,
          description: issue.description,
          severity: issue.severity,
        };
      }),
      createLinearTickets: investigation.createLinearTickets,
      linearIssueTemplate: investigation.linearIssueTemplate,
      markdown,
      automaticPullRequestIssueIds:
        investigation.prMode === "always"
          ? automaticPullRequestRequests.map((request) => request.issueId)
          : [],
      automaticPullRequestRequestIds: automaticPullRequestRequests.map(
        (request) => request.id,
      ),
    };
  });
}

export async function listIssues(
  organizationId: string,
  includeArchived = false,
) {
  return getDatabase()
    .select({
      id: issues.id,
      title: issues.title,
      description: issues.description,
      rootCause: issues.rootCause,
      timeline: issues.timeline,
      severity: issues.severity,
      remediation: issues.remediation,
      remediations: issues.remediations,
      archivedAt: issues.archivedAt,
      createdAt: issues.createdAt,
    })
    .from(issues)
    .where(
      includeArchived
        ? eq(issues.organizationId, organizationId)
        : and(
            eq(issues.organizationId, organizationId),
            isNull(issues.archivedAt),
          ),
    )
    .orderBy(desc(issues.createdAt));
}

export async function getIssueDetail(
  organizationId: string,
  issueId: string,
) {
  const db = getDatabase();
  const issueRows = await db
    .select({
      id: issues.id,
      title: issues.title,
      description: issues.description,
      rootCause: issues.rootCause,
      timeline: issues.timeline,
      severity: issues.severity,
      remediation: issues.remediation,
      remediations: issues.remediations,
      evidence: issues.evidence,
      archivedAt: issues.archivedAt,
      createdAt: issues.createdAt,
    })
    .from(issues)
    .where(
      and(eq(issues.id, issueId), eq(issues.organizationId, organizationId)),
    )
    .limit(1);
  const issue = issueRows[0];
  if (!issue) return null;

  const linearTicketRequests = await db
    .select({
      id: issueLinearTickets.id,
      status: issueLinearTickets.status,
      teamId: issueLinearTickets.teamId,
      projectId: issueLinearTickets.projectId,
      linearIssueId: issueLinearTickets.linearIssueId,
      linearIdentifier: issueLinearTickets.linearIdentifier,
      linearIssueUrl: issueLinearTickets.linearIssueUrl,
      failureReason: issueLinearTickets.failureReason,
      attemptCount: issueLinearTickets.attemptCount,
      createdAt: issueLinearTickets.createdAt,
      updatedAt: issueLinearTickets.updatedAt,
      completedAt: issueLinearTickets.completedAt,
    })
    .from(issueLinearTickets)
    .where(eq(issueLinearTickets.issueId, issueId))
    .orderBy(desc(issueLinearTickets.createdAt));

  const relatedInvestigations = await db
    .select({
      id: investigations.id,
      agentId: investigations.agentId,
      agentName: agents.name,
      title: investigations.title,
      status: investigations.status,
      relationship: investigationIssues.relationship,
      evidence: investigationIssues.evidence,
      createdAt: investigations.createdAt,
      completedAt: investigations.completedAt,
    })
    .from(investigationIssues)
    .innerJoin(
      investigations,
      eq(investigations.id, investigationIssues.investigationId),
    )
    .innerJoin(agents, eq(agents.id, investigations.agentId))
    .where(
      and(
        eq(investigationIssues.issueId, issue.id),
        eq(investigations.organizationId, organizationId),
      ),
    )
    .orderBy(desc(investigations.createdAt));

  return {
    issue,
    investigations: relatedInvestigations,
    linearTicketState: { requests: linearTicketRequests },
    pullRequestState: await getIssuePullRequestState(organizationId, issueId),
  };
}

export async function setIssueArchived(input: {
  archived: boolean;
  issueId: string;
  organizationId: string;
}) {
  const rows = await getDatabase()
    .update(issues)
    .set({
      archivedAt: input.archived ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(issues.id, input.issueId),
        eq(issues.organizationId, input.organizationId),
      ),
    )
    .returning({ id: issues.id, archivedAt: issues.archivedAt });
  return rows[0] ?? null;
}

export async function getIssueForSlackAction(input: {
  issueId: string;
  teamId: string;
}) {
  const rows = await getDatabase()
    .select({
      id: issues.id,
      title: issues.title,
      description: issues.description,
      rootCause: issues.rootCause,
      timeline: issues.timeline,
      severity: issues.severity,
      remediation: issues.remediation,
      remediations: issues.remediations,
      evidence: issues.evidence,
      organizationId: issues.organizationId,
      integrationAccountId: integrationAccounts.id,
      encryptedCredentials: integrationAccounts.encryptedCredentials,
    })
    .from(issues)
    .innerJoin(
      integrationAccounts,
      and(
        eq(integrationAccounts.organizationId, issues.organizationId),
        eq(integrationAccounts.provider, "slack"),
        eq(integrationAccounts.externalAccountId, input.teamId),
        eq(integrationAccounts.status, "connected"),
      ),
    )
    .where(eq(issues.id, input.issueId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getInvestigationIssueDetails(investigationId: string) {
  return getDatabase()
    .select({
      id: issues.id,
      title: issues.title,
      description: issues.description,
      rootCause: issues.rootCause,
      timeline: issues.timeline,
      severity: issues.severity,
      remediation: issues.remediation,
      remediations: issues.remediations,
      relationship: investigationIssues.relationship,
      evidence: investigationIssues.evidence,
      createdAt: issues.createdAt,
    })
    .from(investigationIssues)
    .innerJoin(issues, eq(issues.id, investigationIssues.issueId))
    .where(eq(investigationIssues.investigationId, investigationId))
    .orderBy(issues.createdAt);
}

export async function getIssueForSlackBackfill(input: {
  investigationId: string;
  issueId: string;
}) {
  const rows = await getDatabase()
    .select({
      id: issues.id,
      title: issues.title,
      description: issues.description,
      rootCause: issues.rootCause,
      timeline: issues.timeline,
      severity: issues.severity,
      remediation: issues.remediation,
      remediations: issues.remediations,
      evidence: issues.evidence,
    })
    .from(issues)
    .innerJoin(
      investigations,
      eq(investigations.organizationId, issues.organizationId),
    )
    .where(
      and(
        eq(investigations.id, input.investigationId),
        eq(issues.id, input.issueId),
      ),
    )
    .limit(1);
  const issue = rows[0];
  return issue
    ? {
        ...issue,
        pullRequest: null,
        relationship: "new" as const,
      }
    : null;
}

export interface SlackInvestigationDeliveryContext {
  agentId: string;
  executionMode: "standard" | "slack_thread";
  investigationId: string;
  organizationId?: string;
  prMode: AgentPrMode;
  report: StructuredInvestigationReport;
  title: string;
  traceItems?: InvestigationSlackTraceItem[];
  issues: Array<{
    id: string;
    title: string;
    description: string;
    rootCause: string;
    timeline: Array<{ title: string; description: string }>;
    severity: "SEV-1" | "SEV-2" | "SEV-3";
    remediation: string;
    remediations: IssueRemediation[];
    relationship: "new" | "recurrence";
    evidence: IssueEvidence[];
    pullRequest: {
      id: string;
      remediationId: string | null;
      repositoryFullName: string | null;
      status: "queued" | "creating" | "created" | "merged" | "failed";
      pullRequestNumber: number | null;
      pullRequestUrl: string | null;
      failureReason: string | null;
    } | null;
  }>;
  source: {
    channelId: string;
    encryptedCredentials: string;
    integrationAccountId: string;
    messageTimestamp: string | null;
    reactionTimestamp: string;
    threadTimestamp: string;
  } | null;
  output: {
    channelId: string;
    encryptedCredentials: string;
    integrationAccountId: string;
    severities: Array<"SEV-1" | "SEV-2" | "SEV-3"> | null;
  } | null;
}

export interface SlackInvestigationLiveContext {
  agentId: string;
  executionMode: "standard" | "slack_thread";
  investigationId: string;
  organizationId?: string;
  title: string;
  traceItems: InvestigationSlackTraceItem[];
  source: {
    channelId: string;
    encryptedCredentials: string;
    messageTimestamp: string | null;
    reactionTimestamp?: string;
    responseMessageTimestamp?: string;
    threadTimestamp: string;
  };
}

function slackSourceAccountId(input: {
  trigger: string;
  triggerConfig: Record<string, unknown>;
}): string | null {
  return (input.trigger === "slack_channel" || input.trigger === "slack_mention") &&
    typeof input.triggerConfig.integrationAccountId === "string"
    ? input.triggerConfig.integrationAccountId
    : null;
}

export async function getSlackInvestigationLiveContext(
  investigationId: string,
): Promise<SlackInvestigationLiveContext | null> {
  const rows = await getDatabase()
    .select({
      agentId: investigations.agentId,
      executionMode: investigations.executionMode,
      id: investigations.id,
      input: investigations.input,
      messageTimestamp: investigations.slackMessageTimestamp,
      organizationId: investigations.organizationId,
      slackThreadSnapshot: investigations.slackThreadSnapshot,
      title: investigations.title,
      traceItems: investigations.slackTraceItems,
      trigger: agentConfigVersions.trigger,
      triggerConfig: agentConfigVersions.triggerConfig,
    })
    .from(investigations)
    .innerJoin(
      agentConfigVersions,
      eq(agentConfigVersions.id, investigations.agentConfigVersionId),
    )
    .where(eq(investigations.id, investigationId))
    .limit(1);
  const investigation = rows[0];
  if (!investigation || investigation.input.provider !== "slack") return null;

  const accountId =
    typeof investigation.input.attributes?.integrationAccountId === "string"
      ? investigation.input.attributes.integrationAccountId
      : slackSourceAccountId({
          trigger: investigation.trigger,
          triggerConfig: investigation.triggerConfig,
        });
  const channelId = investigation.input.attributes?.channelId;
  const sourceTimestamp = investigation.input.attributes?.timestamp;
  const threadTimestamp =
    investigation.input.attributes?.threadTimestamp ?? sourceTimestamp;
  if (
    !accountId ||
    typeof channelId !== "string" ||
    typeof sourceTimestamp !== "string" ||
    typeof threadTimestamp !== "string"
  ) {
    return null;
  }

  const accounts = await getDatabase()
    .select({ encryptedCredentials: integrationAccounts.encryptedCredentials })
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.id, accountId),
        eq(integrationAccounts.organizationId, investigation.organizationId),
        eq(integrationAccounts.provider, "slack"),
        eq(integrationAccounts.status, "connected"),
      ),
    )
    .limit(1);
  const encryptedCredentials = accounts[0]?.encryptedCredentials;
  if (!encryptedCredentials) return null;
  const responseMessageTimestamp = investigation.slackThreadSnapshot?.replies.find(
    (reply) => reply.key === "thread-response",
  )?.slackTimestamp;

  return {
    agentId: investigation.agentId,
    executionMode: investigation.executionMode,
    investigationId: investigation.id,
    organizationId: investigation.organizationId,
    title: investigation.title,
    traceItems: investigation.traceItems,
    source: {
      channelId,
      encryptedCredentials,
      messageTimestamp: investigation.messageTimestamp,
      reactionTimestamp: sourceTimestamp,
      ...(responseMessageTimestamp ? { responseMessageTimestamp } : {}),
      threadTimestamp,
    },
  };
}

export async function getSlackInvestigationDeliveryContext(
  investigationId: string,
): Promise<SlackInvestigationDeliveryContext | null> {
  const db = getDatabase();
  const rows = await db
    .select({
      agentId: investigations.agentId,
      executionMode: investigations.executionMode,
      id: investigations.id,
      input: investigations.input,
      messageTimestamp: investigations.slackMessageTimestamp,
      organizationId: investigations.organizationId,
      report: investigations.structuredReport,
      title: investigations.title,
      traceItems: investigations.slackTraceItems,
      prMode: agentConfigVersions.prMode,
      reportConfig: agentConfigVersions.reportConfig,
      trigger: agentConfigVersions.trigger,
      triggerConfig: agentConfigVersions.triggerConfig,
    })
    .from(investigations)
    .innerJoin(
      agentConfigVersions,
      eq(agentConfigVersions.id, investigations.agentConfigVersionId),
    )
    .where(eq(investigations.id, investigationId))
    .limit(1);
  const investigation = rows[0];
  if (!investigation?.report) return null;

  const sourceAccountId = investigation.input.provider === "slack"
    ? typeof investigation.input.attributes?.integrationAccountId === "string"
      ? investigation.input.attributes.integrationAccountId
      : slackSourceAccountId({
          trigger: investigation.trigger,
          triggerConfig: investigation.triggerConfig,
        })
    : null;
  const outputConfig =
    investigation.reportConfig.mode === "thread"
      ? null
      : investigation.reportConfig;
  const accountIds = [
    ...new Set(
      [sourceAccountId, outputConfig?.integrationAccountId].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ];
  const accountRows = accountIds.length
    ? await db
        .select({
          id: integrationAccounts.id,
          encryptedCredentials: integrationAccounts.encryptedCredentials,
        })
        .from(integrationAccounts)
        .where(
          and(
            inArray(integrationAccounts.id, accountIds),
            eq(integrationAccounts.organizationId, investigation.organizationId),
            eq(integrationAccounts.provider, "slack"),
            eq(integrationAccounts.status, "connected"),
          ),
        )
    : [];
  const credentialsByAccount = new Map(
    accountRows.map((account) => [account.id, account.encryptedCredentials]),
  );
  const sourceChannelId = investigation.input.attributes?.channelId;
  const sourceReactionTimestamp = investigation.input.attributes?.timestamp;
  const sourceTimestamp =
    investigation.input.attributes?.threadTimestamp ??
    investigation.input.attributes?.timestamp;
  const sourceCredentials = sourceAccountId
    ? credentialsByAccount.get(sourceAccountId)
    : null;
  const outputCredentials = outputConfig
    ? credentialsByAccount.get(outputConfig.integrationAccountId)
    : null;
  const issueDetails = await getInvestigationIssueDetails(investigation.id);
  const pullRequestRows = await db
    .select({
      id: issuePullRequests.id,
      issueId: issuePullRequests.issueId,
      remediationId: issuePullRequests.remediationId,
      repositoryFullName: issuePullRequests.repositoryFullName,
      status: issuePullRequests.status,
      pullRequestNumber: issuePullRequests.pullRequestNumber,
      pullRequestUrl: issuePullRequests.pullRequestUrl,
      failureReason: issuePullRequests.failureReason,
    })
    .from(issuePullRequests)
    .where(eq(issuePullRequests.investigationId, investigation.id))
    .orderBy(desc(issuePullRequests.createdAt));
  const pullRequestByIssueId = new Map<string, (typeof pullRequestRows)[number]>();
  for (const request of pullRequestRows) {
    if (!pullRequestByIssueId.has(request.issueId)) {
      pullRequestByIssueId.set(request.issueId, request);
    }
  }

  return {
    agentId: investigation.agentId,
    executionMode: investigation.executionMode,
    investigationId: investigation.id,
    organizationId: investigation.organizationId,
    prMode: investigation.prMode,
    report: investigation.report,
    title: investigation.title,
    traceItems: investigation.traceItems,
    issues: issueDetails.map((issue) => ({
      ...issue,
      pullRequest: pullRequestByIssueId.get(issue.id) ?? null,
    })),
    source:
      typeof sourceChannelId === "string" &&
      typeof sourceReactionTimestamp === "string" &&
      typeof sourceTimestamp === "string" &&
      sourceAccountId &&
      sourceCredentials
        ? {
            channelId: sourceChannelId,
            encryptedCredentials: sourceCredentials,
            integrationAccountId: sourceAccountId,
            messageTimestamp: investigation.messageTimestamp,
            reactionTimestamp: sourceReactionTimestamp,
            threadTimestamp: sourceTimestamp,
          }
        : null,
    output:
      outputConfig && outputCredentials
        ? {
            channelId: outputConfig.outputChannelId,
            encryptedCredentials: outputCredentials,
            integrationAccountId: outputConfig.integrationAccountId,
            severities: outputConfig.severities ?? null,
          }
        : null,
  };
}

export type IssueDetailEvidence = IssueEvidence;
