import { waiveJobUsage } from "@responder/core/billing/usage-waivers";
import { failIssuePullRequest } from "@responder/core/db/pull-requests";
import { UsageAllowanceExhaustedError } from "./agent-usage.js";
import { failSuggestionPullRequest } from "@responder/core/db/suggestion-pull-requests";
import type { RemediationJob } from "@responder/core/jobs";
import { refreshIssuePullRequestSlackMessages } from "@responder/core/integrations/slack-remediations";
import { runProposedRemediation } from "./remediate.js";
import { safeInvestigationError } from "./investigate.js";
import { reportWorkerException } from "./monitoring.js";

interface RemediationJobDependencies {
  failRequest: typeof failIssuePullRequest;
  failSuggestionRequest?: typeof failSuggestionPullRequest;
  reportException: typeof reportWorkerException;
  refreshSlack?: typeof refreshIssuePullRequestSlackMessages;
  runRemediation: typeof runProposedRemediation;
  waiveUsage: typeof waiveJobUsage;
}

const defaultDependencies: RemediationJobDependencies = {
  failRequest: failIssuePullRequest,
  failSuggestionRequest: failSuggestionPullRequest,
  reportException: reportWorkerException,
  refreshSlack: refreshIssuePullRequestSlackMessages,
  runRemediation: runProposedRemediation,
  waiveUsage: waiveJobUsage,
};

export async function processRemediationJob(
  jobId: string,
  payload: RemediationJob,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: RemediationJobDependencies = defaultDependencies,
): Promise<{ requestId: string }> {
  const usageSince = new Date();
  try {
    await dependencies.runRemediation(payload, environment);
  } catch (error) {
    // Pull request work that failed is not charged. A waiver that fails is
    // reported and leaves it charged.
    await dependencies.waiveUsage({
      since: usageSince,
      workload: "remediation",
      workloadId: payload.remediationRequestId,
    }).catch((waiveError: unknown) =>
      Promise.resolve().then(() => dependencies.reportException(waiveError, {
        investigationId: payload.investigationId,
        jobId,
        operation: "remediation",
        organizationId: payload.config.organizationId,
        requestId: payload.remediationRequestId,
      })).catch(() => undefined));
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
        ("suggestion" in payload
          ? dependencies.failSuggestionRequest ?? failSuggestionPullRequest
          : dependencies.failRequest)(payload.remediationRequestId, message)
      ),
      Promise.resolve().then(() =>
        // A used-up allowance is an expected outcome, not a fault.
        error instanceof UsageAllowanceExhaustedError ? undefined : dependencies.reportException(error, {
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

    if (!("suggestion" in payload)) {
      await dependencies.refreshSlack?.(payload.remediationRequestId);
    }
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
