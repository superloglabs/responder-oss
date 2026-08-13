import { getIssueForSlackAction } from "../../../../packages/core/src/db/issues.js";
import {
  IssuePullRequestError,
  queueManualIssuePullRequest,
} from "../../../../packages/core/src/db/pull-requests.js";
import { queueIssueRemediation } from "../investigations/queue.js";

export type IssueRemediationStartResult =
  | {
      ok: true;
      requestId: string;
      sessionId: string | null;
    }
  | {
      ok: false;
      error: string;
      status: 502 | 503;
    };

export async function startIssueRemediation(input: {
  issueId: string;
  organizationId: string;
}): Promise<IssueRemediationStartResult> {
  const queued = await queueManualIssuePullRequest(input);
  try {
    const job = await queueIssueRemediation(queued.id);
    return {
      ok: true,
      requestId: job.requestId,
      sessionId: `openai-daytona:${job.jobId}`,
    };
  } catch (caught) {
    const error =
      caught instanceof Error ? caught.message : "Unable to start remediation";
    return { ok: false, error, status: 502 };
  }
}

export async function startSlackIssueRemediation(input: {
  issueId: string;
  teamId: string;
}): Promise<IssueRemediationStartResult> {
  const issue = await getIssueForSlackAction(input);
  if (!issue) {
    throw new IssuePullRequestError("Issue not found", "issue_not_found");
  }
  return startIssueRemediation({
    issueId: issue.id,
    organizationId: issue.organizationId,
  });
}
