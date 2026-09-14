import { failIssuePullRequest } from "@responder/core/db/pull-requests";
import type { RemediationJob } from "@responder/core/jobs";
import { refreshIssuePullRequestSlackMessages } from "@responder/core/integrations/slack-remediations";
import { runProposedRemediation } from "./remediate.js";
import { safeInvestigationError } from "./investigate.js";
import { reportWorkerException } from "./monitoring.js";

interface RemediationJobDependencies {
  failRequest: typeof failIssuePullRequest;
  reportException: typeof reportWorkerException;
  refreshSlack?: typeof refreshIssuePullRequestSlackMessages;
  runRemediation: typeof runProposedRemediation;
}

const defaultDependencies: RemediationJobDependencies = {
  failRequest: failIssuePullRequest,
  reportException: reportWorkerException,
  refreshSlack: refreshIssuePullRequestSlackMessages,
  runRemediation: runProposedRemediation,
};

export async function processRemediationJob(
  jobId: string,
  payload: RemediationJob,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: RemediationJobDependencies = defaultDependencies,
): Promise<{ requestId: string }> {
  try {
    await dependencies.runRemediation(payload, environment);
  } catch (error) {
    const message = safeInvestigationError(error, environment);
    console.error(
      JSON.stringify({
        error: message,
        event: "remediation_job_failed",
        jobId,
        requestId: payload.remediationRequestId,
      }),
    );
    const [recordingResult, reportingResult] = await Promise.allSettled([
      Promise.resolve().then(() =>
        dependencies.failRequest(payload.remediationRequestId, message)
      ),
      Promise.resolve().then(() =>
        dependencies.reportException(error, {
          investigationId: payload.investigationId,
          jobId,
          operation: "remediation",
          organizationId: payload.config.organizationId,
          requestId: payload.remediationRequestId,
        })
      ),
    ]);

    if (reportingResult.status === "rejected") {
      console.error(
        JSON.stringify({
          error: safeInvestigationError(reportingResult.reason, environment),
          event: "remediation_error_reporting_failed",
          jobId,
          requestId: payload.remediationRequestId,
        }),
      );
    }

    if (recordingResult.status === "rejected") {
      console.error(
        JSON.stringify({
          error: safeInvestigationError(recordingResult.reason, environment),
          event: "remediation_failure_recording_failed",
          jobId,
          requestId: payload.remediationRequestId,
        }),
      );
      throw new AggregateError(
        [
          error,
          recordingResult.reason,
          ...(reportingResult.status === "rejected"
            ? [reportingResult.reason]
            : []),
        ],
        "Unable to record remediation failure",
      );
    }

    await dependencies.refreshSlack?.(payload.remediationRequestId);
    return { requestId: payload.remediationRequestId };
  }

  console.log(
    JSON.stringify({
      event: "remediation_job_complete",
      jobId,
      requestId: payload.remediationRequestId,
    }),
  );

  return { requestId: payload.remediationRequestId };
}
