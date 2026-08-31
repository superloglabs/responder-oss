import { getIssueForSlackAction } from "../../../../packages/core/src/db/issues.js";
import {
  IssuePullRequestError,
  queueManualIssuePullRequest,
} from "../../../../packages/core/src/db/pull-requests.js";
import { queueIssueRemediation } from "../investigations/queue.js";
import type { SlackIssuePullRequestCard } from "../../../../packages/core/src/integrations/slack-remediations.js";

export type IssueRemediationStartResult =
  | {
      ok: true;
      requestId: string;
      requestIds?: string[];
      sessionId: string | null;
      sessionIds?: Array<string | null>;
    }
  | {
      ok: false;
      error: string;
      status: 502 | 503;
    };

export async function startIssueRemediation(input: {
  issueId: string;
  organizationId: string;
  remediationId: string;
}): Promise<IssueRemediationStartResult> {
  const queued = await queueManualIssuePullRequest(input);
  try {
    const requests = Array.isArray(queued) ? queued : [queued];
    const jobs = await Promise.all(
      requests.map((request) => queueIssueRemediation(request.id)),
    );
    return {
      ok: true,
      requestId: jobs[0]!.requestId,
      requestIds: jobs.map((job) => job.requestId),
      sessionId: `openai-daytona:${jobs[0]!.jobId}`,
      sessionIds: jobs.map((job) => `openai-daytona:${job.jobId}`),
    };
  } catch (caught) {
    const error =
      caught instanceof Error ? caught.message : "Unable to start remediation";
    return { ok: false, error, status: 502 };
  }
}

export async function startSlackIssueRemediation(input: {
  issueId: string;
  remediationId?: string;
  teamId: string;
}): Promise<
  | Exclude<IssueRemediationStartResult, { ok: true }>
  | (Extract<IssueRemediationStartResult, { ok: true }> & {
      card: SlackIssuePullRequestCard;
      integrationAccountId: string;
    })
> {
  const issue = await getIssueForSlackAction(input);
  if (!issue) {
    throw new IssuePullRequestError("Issue not found", "issue_not_found");
  }
  const remediation = issue.remediations.find(
    (candidate) =>
      candidate.type === "code_change" &&
      (!input.remediationId || candidate.id === input.remediationId),
  );
  if (!remediation) {
    throw new IssuePullRequestError(
      "This issue does not have a code remediation",
      "not_available",
    );
  }
  const result = await startIssueRemediation({
    issueId: issue.id,
    organizationId: issue.organizationId,
    remediationId: remediation.id,
  });
  return result.ok
    ? {
        ...result,
        integrationAccountId: issue.integrationAccountId,
        card: {
          failureReason: null,
          issueId: issue.id,
          issueSeverity: issue.severity,
          issueTitle: issue.title,
          pullRequestNumber: null,
          pullRequestUrl: null,
          repositoryFullName: null,
          requestId: result.requestId,
          selectedRemediation: remediation,
          status: "creating",
        },
      }
    : result;
}
